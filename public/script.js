// script.js
(function() { // Wrap in IIFE (Immediately Invoked Function Expression)
    'use strict'; // Enable strict mode

    // --- State Variables ---
    let messageCount = 0;
    let selectedFile = null;
    let currentStreamId = null;
    let eventSource = null;
    let currentBotMessageDiv = null;
    let currentBotMessageWrapper = null; // Keep track of the whole message div

    // --- DOM Elements (cache them) ---
    const chatContainer = document.getElementById("chatContainer");
    const inputField = document.getElementById("text");
    const sendButton = document.getElementById("send");
    const stopButton = document.getElementById("stop");
    const attachmentButton = document.getElementById("attachment");
    const fileInput = document.getElementById("fileInput");
    const statusIndicator = document.getElementById("statusIndicator");

    // --- Utility Functions ---
    function scrollToBottom() {
        const isScrolledToBottom = chatContainer.scrollHeight - chatContainer.clientHeight <= chatContainer.scrollTop + 30; // Threshold
        if (isScrolledToBottom) {
            chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior: 'smooth' });
        }
    }

    function capitalizeFirstLetter(string) {
        return string ? string.charAt(0).toUpperCase() + string.slice(1) : '';
    }

    // Updates UI state (buttons, input, status)
    function setUiState(state) {
        const isIdle = state === 'idle';
        const isRequesting = state === 'requesting';
        const isStreaming = state === 'streaming';
        const isError = state === 'error';
        const isStopped = state === 'stopped'; // Add stopped state

        inputField.disabled = isRequesting || isStreaming;
        attachmentButton.disabled = isRequesting || isStreaming;

        sendButton.style.display = isStreaming ? 'none' : 'inline-flex';
        sendButton.disabled = isRequesting || isStreaming;

        stopButton.style.display = isStreaming ? 'inline-flex' : 'none';

        // Update Status Indicator Text
        if (isIdle) statusIndicator.textContent = "Ready";
        else if (isRequesting) statusIndicator.textContent = "Sending request...";
        else if (isStreaming) statusIndicator.textContent = "Assistant is responding...";
        else if (isError) statusIndicator.textContent = "Error occurred";
        else if (isStopped) statusIndicator.textContent = "Generation stopped";
        else statusIndicator.textContent = "Ready"; // Default


        // Manage streaming indicator class on the message body
        if (currentBotMessageDiv) {
            if (isStreaming) {
                currentBotMessageDiv.classList.add('streaming');
            } else {
                currentBotMessageDiv.classList.remove('streaming');
            }
        }
        // Reset message references when not actively receiving
        if (!isStreaming && !isRequesting) {
             currentBotMessageDiv = null;
             currentBotMessageWrapper = null;
        }
    }

    // Appends a message div. Returns the BODY element of the new message.
    function appendMessage(sender, message, type = 'normal') { // type = 'normal', 'error', 'info'
        const uniqueId = `${sender}-msg-${messageCount++}`;
        let senderClass = sender;
        let headerText = capitalizeFirstLetter(sender);
        if(type === 'error') senderClass += ' error';
        if(type === 'info') senderClass += ' user info'; // Style info like user but centered/italic
        if(type === 'info') headerText = 'Info';

        // Basic sanitization (prevent simple HTML injection)
        const sanitizedMessage = message.replace(/</g, "<").replace(/>/g, ">");

        const messageHtml = `
          <div class="message ${senderClass}" id="${uniqueId}-wrapper">
            <div class="msg-header">${headerText}</div>
            <div class="msg-body" id="${uniqueId}">${sanitizedMessage}</div>
          </div>
        `;
        chatContainer.insertAdjacentHTML('beforeend', messageHtml);
        const newMsgBody = document.getElementById(uniqueId);
        const newMsgWrapper = document.getElementById(`${uniqueId}-wrapper`);

        // Store references only for the expected *next* bot response
        if (sender === 'model' && type === 'normal') {
            currentBotMessageDiv = newMsgBody;
            currentBotMessageWrapper = newMsgWrapper;
        }

        scrollToBottom(); // Scroll after adding
        return newMsgBody; // Return the body element
    }

    // --- Core Logic: SSE Handling ---

    function handleStreamMessage(event) {
        try {
            const data = JSON.parse(event.data);

            if (!currentBotMessageDiv) {
                 console.warn("Received stream data but no target message div exists. Data:", data);
                 // If it's not just a chunk, try to display it as a new message
                 if(data.type !== 'chunk' && data.content) {
                      appendMessage('model', `[${data.type}] ${data.content}`, data.type === 'error' ? 'error' : 'info');
                 }
                 if (data.type !== 'chunk') closeStreamAndReset(data.type === 'error');
                 return;
            }

            // Append text chunk
            if (data.type === 'chunk' && data.content) {
                 // Append text safely
                 currentBotMessageDiv.textContent += data.content;
                 scrollToBottom(); // Keep scrolling
            }
            // Handle final messages (error, info, done)
            else if (data.type === 'error' || data.type === 'info' || data.type === 'done') {
                if (data.content && data.type !== 'done') { // Display error/info content
                    // Append to existing message if possible, otherwise create new
                    currentBotMessageDiv.textContent += `\n[${capitalizeFirstLetter(data.type)}: ${data.content}]`;
                    if (data.type === 'error' && currentBotMessageWrapper) {
                         currentBotMessageWrapper.classList.add('error'); // Style wrapper
                    }
                }
                console.log(`Stream final message: ${data.type}`);
                closeStreamAndReset(data.type === 'error'); // Close stream, indicate error if applicable
            }

        } catch (parseError) {
            console.error("Failed to parse SSE data:", event.data, parseError);
            if (currentBotMessageDiv) {
                currentBotMessageDiv.textContent += '\n[Error: Invalid response from server]';
                 if(currentBotMessageWrapper) currentBotMessageWrapper.classList.add('error');
            } else {
                 appendMessage('model', '[Error: Invalid response from server]', 'error');
            }
            closeStreamAndReset(true);
        }
    }

    function handleStreamError(error) {
        console.error("EventSource connection failed:", error);
        // Only display error if we were actively streaming and don't have one already
        if(statusIndicator.textContent.includes("Generating...")) { // Check state without relying on variable
            if (currentBotMessageDiv && !currentBotMessageDiv.textContent.includes('Error')) {
                currentBotMessageDiv.textContent += '\n[Error: Connection to server lost]';
                if(currentBotMessageWrapper) currentBotMessageWrapper.classList.add('error');
            } else if (!currentBotMessageDiv) { // If placeholder wasn't even created
                appendMessage('model', '[Error: Connection to server lost]', 'error');
            }
        } else {
             console.log("SSE error occurred but not during active streaming, UI state:", statusIndicator.textContent);
        }
        closeStreamAndReset(true);
    }

    // Closes EventSource and resets state
    function closeStreamAndReset(isError = false) {
        console.log(`Closing stream and resetting state. Error: ${isError}`);
        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }
        currentStreamId = null;
        // Update UI state after a short delay for final rendering/logging
        setTimeout(() => setUiState(isError ? 'error' : 'idle'), 100);
    }

    // --- Core Logic: Initiating Request ---

    async function requestStreamOrFAQ(formData) {
        setUiState('requesting');
        // Create placeholder for bot response *before* making the request
        appendMessage("model", ""); // Creates placeholder, stores refs in globals
        if (!currentBotMessageDiv) {
            console.error("Failed to create placeholder message div.");
            appendMessage("model", "[Internal error creating response area]", 'error');
            setUiState('error');
            return;
        }
        // currentBotMessageDiv.textContent = ''; // Ensure it's empty

        try {
            const response = await fetch("/request-stream", {
                method: "POST",
                body: formData,
            });

            if (!response.ok) {
                let errorText = `Server error (${response.status})`;
                try { const errorData = await response.json(); errorText = errorData.error || errorText; } catch (e) {}
                throw new Error(errorText);
            }

            const data = await response.json();

            // --- Handle Direct FAQ Response ---
            if (data.directResponse) {
                console.log("Received direct FAQ response.");
                currentBotMessageDiv.textContent = data.directResponse; // Display FAQ answer
                setUiState('idle'); // Reset UI to idle
                return; // Stop processing, handled directly
            }

            // --- Proceed with Stream ---
            if (!data.streamId) {
                throw new Error("Did not receive stream ID or direct response.");
            }

            currentStreamId = data.streamId;
            console.log("Received streamId:", currentStreamId);

            // Connect to the SSE endpoint
            console.log("Connecting to SSE:", `/stream/${currentStreamId}`);
            eventSource = new EventSource(`/stream/${currentStreamId}`);
            eventSource.onmessage = handleStreamMessage;
            eventSource.onerror = handleStreamError;

            // Transition UI to streaming state *now*
            setUiState('streaming');

        } catch (error) {
            console.error("Error requesting stream/FAQ:", error);
            if(currentBotMessageDiv) {
                 currentBotMessageDiv.textContent = `[Error: ${error.message || 'Failed to start stream'}]`;
                 if(currentBotMessageWrapper) currentBotMessageWrapper.classList.add('error');
            } else {
                 appendMessage("model", `[Error: ${error.message || 'Failed to start stream'}]`, 'error');
            }
            closeStreamAndReset(true); // Reset UI to error state
        }
        // No finally block needed here for selectedFile, cleared in handleSendMessage
    }

    // --- Event Handlers ---

    function handleSendMessage(event) {
         if(event) event.preventDefault(); // Prevent default form actions

        const rawText = inputField.value;
        const uiState = statusIndicator.textContent; // Simple state check

        // Prevent sending if not ready or input is effectively empty
        if ((!uiState.includes('Ready') && !uiState.includes('Error') && !uiState.includes('stopped')) // Allow sending after error/stop
            || (!rawText.trim() && !selectedFile)) {
             console.log("Send blocked: State is", uiState, "or input/file empty.");
             return;
        }

        // Display user message
        const userMsgText = rawText || `Sent File: ${selectedFile?.name || 'Unknown'}`;
        appendMessage("user", userMsgText);
        inputField.value = ""; // Clear input

        const formData = new FormData();
        // Send empty string msg if only file exists, backend expects 'msg' field
        formData.append("msg", rawText);
        if (selectedFile) {
            formData.append("image", selectedFile, selectedFile.name);
        }

        requestStreamOrFAQ(formData); // Initiate the stream/FAQ request
        selectedFile = null; // Clear file selection *after* initiating request
    }

    async function handleStopStreaming() {
        console.log("Stop button clicked.");
        const streamIdToStop = currentStreamId;

        if (!streamIdToStop || !eventSource) {
            console.warn("Stop clicked but no active stream/EventSource found.");
            closeStreamAndReset(false); // Just reset UI
            return;
        }

        // Update UI immediately to show stopping action
        setUiState('stopped'); // Use 'stopped' state
         if(currentBotMessageDiv) {
              currentBotMessageDiv.textContent += "\n[Stopping...]";
              currentBotMessageDiv.classList.remove('streaming'); // Stop blinking cursor
         }

        // Close frontend EventSource first
        eventSource.close();
        eventSource = null;

        // Tell the server to stop processing and clean up
        try {
            console.log(`Sending stop request for stream ID: ${streamIdToStop}`);
            const response = await fetch(`/stop/${streamIdToStop}`, { method: "POST" });
            if (!response.ok) {
                console.warn("Server responded with error on stop request:", response.status);
                 if(currentBotMessageDiv) currentBotMessageDiv.textContent = currentBotMessageDiv.textContent.replace("\n[Stopping...]", "\n[Stop signal sent, server error]");
            } else {
                 console.log("Stop signal acknowledged by server.");
                 if(currentBotMessageDiv) currentBotMessageDiv.textContent = currentBotMessageDiv.textContent.replace("\n[Stopping...]", "\n[Stopped by user]");
            }
        } catch (error) {
            console.error("Error sending stop signal to server:", error);
             if(currentBotMessageDiv) currentBotMessageDiv.textContent = currentBotMessageDiv.textContent.replace("\n[Stopping...]", "\n[Error stopping stream]");
        } finally {
             // Ensure state is fully reset
             closeStreamAndReset(false); // Reset to idle after stop attempt
        }
    }

    function handleFileSelection(event) {
        const file = event.target.files[0];
        if (file) {
             // Basic validation
             if (!file.type.startsWith('image/')) {
                  appendMessage("model", 'Please select an image file (JPEG, PNG, GIF, WEBP).', 'error');
                  event.target.value = null; return;
             }
             if (file.size > 10 * 1024 * 1024) { // Example: 10MB limit
                   appendMessage("model", 'File size exceeds 10MB limit.', 'error');
                   event.target.value = null; return;
             }
             selectedFile = file;
             // Display info message instead of putting filename in input
             appendMessage("user info", `Ready to send: ${selectedFile.name}`);
             inputField.focus(); // Focus input field after selecting file
        }
         // Reset file input visually
         event.target.value = null;
    }

    // --- Initialize ---
    function attachEventListeners() {
        sendButton.addEventListener("click", handleSendMessage);
        stopButton.addEventListener("click", handleStopStreaming);

        inputField.addEventListener("keypress", (event) => {
            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                handleSendMessage(event);
            }
        });

        attachmentButton.addEventListener("click", () => {
            if (!inputField.disabled) { // Only allow attachment if not busy
                 fileInput.click();
            }
        });

        fileInput.addEventListener("change", handleFileSelection);

        // Initial message from bot
        appendMessage("model", "Hello! I am PakScholarship Assist. Ask me about Master's scholarships abroad for Pakistani students.");
        // Set initial UI state
        setUiState('idle');
    }

    // Start when the DOM is ready
    document.addEventListener("DOMContentLoaded", attachEventListeners);

}()); // End of IIFE