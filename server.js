require('dotenv').config();
const express = require('express');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const crypto = require('crypto');

const app = express();

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = 'uploads/';
const MAX_HISTORY_TURNS = 5;
const STREAM_TIMEOUT = 60000;

// --- Ensure 'uploads' directory exists ---
if (!fs.existsSync(UPLOAD_DIR)) {
    try {
        fs.mkdirSync(UPLOAD_DIR);
        console.log(`Created directory: ${UPLOAD_DIR}`);
    } catch (err) {
        console.error(`Error creating upload directory ${UPLOAD_DIR}:`, err);
        process.exit(1);
    }
}
const upload = multer({ dest: UPLOAD_DIR });

// --- Check for API Key ---
if (!process.env.GEMINI_API_KEY) {
    console.error('FATAL ERROR: GEMINI_API_KEY is not set in the .env file.');
    process.exit(1);
}

// --- Initialize Google AI ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- Middleware ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- In-Memory Storage ---
let conversationHistory = [];
const activeStreams = new Map();

// --- Updated FAQ System ---
const faqs = {
    "what scholarships are available?": "I can help with scholarships for Pakistani students! Some options include Chevening (UK), DAAD (Germany), Fulbright (USA), Erasmus Mundus (Europe), and Australia Awards (Australia). Ask about a specific scholarship or country!",
    "hello": "Hello! I’m PakScholarship Assist, here to help Pakistani students find Master’s scholarships abroad. Ask me about scholarships like Chevening or DAAD!",
    "hi": "Hi there! I can help with Master’s scholarships for Pakistani students studying abroad. What would you like to know?",
    "thanks": "You’re welcome! Let me know if you have more questions about scholarships.",
    "thank you": "You’re welcome! Feel free to ask more about scholarships for studying abroad.",
    "help": "I can provide information about Master’s scholarships abroad for Pakistani students. Ask me about eligibility, application processes, deadlines, or specific countries like the UK, USA, Germany, etc.",
    "what can you do?": "I’m PakScholarship Assist, specializing in Master’s scholarships for Pakistani students aiming to study overseas. I can help with eligibility, funding, deadlines, and more. Ask about scholarships like Chevening, DAAD, or Fulbright!",
    "how to apply for a scholarship?": "The application process depends on the scholarship. For example, Chevening requires an online application, essays, and references, while DAAD often needs a research proposal. Which scholarship are you interested in?",
    "what is the deadline for chevening?": "The deadline for the Chevening Scholarship is usually in November each year, likely November 2025 for the next cycle. Check their official website for exact dates: https://www.chevening.org.",
    "what scholarships are available in germany?": "For Pakistani students, the DAAD Scholarship is a great option in Germany. It offers a monthly stipend, travel allowance, and insurance. Deadlines vary by program, so check https://www.daad.de for details."
};

// --- Keyword-Based Input Filtering ---
const scholarshipKeywords = [
    "scholarship", "master", "abroad", "funding", "study", "pakistani",
    "chevening", "daad", "fulbright", "erasmus", "australia awards",
    "uk", "usa", "germany", "europe", "australia", "japan", "korea", "malaysia"
];

function isScholarshipQuery(userInput) {
    const lowerCaseInput = userInput.toLowerCase();
    return scholarshipKeywords.some(keyword => lowerCaseInput.includes(keyword));
}

// --- Helper Function to Clean Up Files ---
function cleanupTempFile(filePath, streamId = 'N/A') {
    if (filePath) {
        fs.unlink(filePath, (err) => {
            if (err) {
                console.error(`[${streamId}] Error deleting temp file ${filePath}:`, err);
            } else {
                console.log(`[${streamId}] Deleted temp file: ${filePath}`);
            }
        });
    }
}

// --- Route to INITIATE the stream ---
app.post('/request-stream', upload.single('image'), (req, res) => {
    const userInput = req.body.msg?.trim() || '';
    const file = req.file;
    let tempFilePath = file ? file.path : null;

    if (!userInput && !file) {
        return res.status(400).json({ error: "'msg' text or an image file is required." });
    }

    if (file && !file.mimetype.startsWith('image/')) {
        console.log(`[INVALID_FILE] User uploaded non-image: ${file.originalname} (${file.mimetype})`);
        cleanupTempFile(tempFilePath, 'INVALID_FILE');
        return res.status(400).json({ error: "Only image files (JPEG, PNG, GIF, WEBP) are supported." });
    }

    // --- FAQ Check (only if no image is present) ---
    const lowerCaseInput = userInput.toLowerCase();
    if (!file && faqs[lowerCaseInput]) {
        console.log(`[FAQ] Matched: "${userInput}". Sending predefined response.`);
        return res.json({ directResponse: faqs[lowerCaseInput] });
    }

    // --- Input Filtering (only if no image is present) ---
    if (!file && !isScholarshipQuery(userInput)) {
        console.log(`[OFF_TOPIC] Query: "${userInput}". Redirecting to scholarship topic.`);
        return res.json({
            directResponse: "I’m PakScholarship Assist, here to help with Master’s scholarships abroad for Pakistani students! Please ask about scholarships, like Chevening, DAAD, or Fulbright."
        });
    }

    // --- Proceed with Stream Request (for Gemini API) ---
    const streamId = crypto.randomUUID();
    console.log(`[${streamId}] Received request. User: "${userInput || '(No text)'}", File: ${file?.originalname || 'None'}`);

    const textPromptPart = userInput ? [{ text: userInput }] : [];
    const mimeType = file ? file.mimetype : null;

    activeStreams.set(streamId, {
        status: 'pending',
        currentUserInputParts: textPromptPart,
        tempFilePath: tempFilePath,
        mimeType: mimeType,
        controller: null,
        stop: null,
        accumulatedBotResponse: ''
    });

    console.log(`[${streamId}] Pending stream created. Returning streamId.`);
    res.status(200).json({ streamId });

    setTimeout(() => {
        const streamData = activeStreams.get(streamId);
        if (streamData && streamData.status === 'pending') {
            console.log(`[${streamId}] Cleaning up timed-out pending stream.`);
            cleanupTempFile(streamData.tempFilePath, streamId);
            activeStreams.delete(streamId);
        }
    }, STREAM_TIMEOUT);
});

// --- Route for the ACTUAL SSE stream connection ---
app.get('/stream/:streamId', async (req, res) => {
    const { streamId } = req.params;
    console.log(`[${streamId}] Client connected for streaming.`);

    const streamData = activeStreams.get(streamId);

    if (!streamData || streamData.status !== 'pending') {
        console.log(`[${streamId}] Invalid or already processed stream ID.`);
        return res.status(404).send('Invalid or expired stream ID.');
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });

    streamData.status = 'streaming';
    streamData.controller = res;

    let shouldStop = false;
    streamData.stop = () => {
        console.log(`[${streamId}] Stop signal received internally.`);
        shouldStop = true;
    };

    const sendSseChunk = (data) => {
        if (res.writableEnded) {
            console.log(`[${streamId}] Attempted to write to closed stream.`);
            shouldStop = true;
            return;
        }
        try {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch (writeError) {
            console.error(`[${streamId}] Error writing to SSE stream:`, writeError);
            shouldStop = true;
        }
    };

    req.on('close', () => {
        console.log(`[${streamId}] Client closed connection unexpectedly.`);
        shouldStop = true;
        cleanupTempFile(streamData.tempFilePath, streamId);
        if (activeStreams.has(streamId)) {
            activeStreams.delete(streamId);
        }
    });

    try {
        const currentTurnParts = [...streamData.currentUserInputParts];

        if (streamData.tempFilePath && streamData.mimeType) {
            console.log(`[${streamId}] Reading image file for stream: ${streamData.tempFilePath}`);
            try {
                const fileData = fs.readFileSync(streamData.tempFilePath);
                const imagePart = { inlineData: { data: fileData.toString("base64"), mimeType: streamData.mimeType } };
                currentTurnParts.push(imagePart);
            } catch (readError) {
                console.error(`[${streamId}] Failed to read image file:`, readError);
                throw new Error("Failed to process uploaded image file.");
            }
        }

        if (currentTurnParts.length === 0) {
            throw new Error("Cannot generate content with empty prompt parts.");
        }

        const formattedHistory = conversationHistory.map(turn => ({
            role: turn.role,
            parts: turn.parts
        }));

        // Prepend scholarship context to the user’s input
        const scholarshipContext = "This is a query about Master’s scholarships abroad for Pakistani students: ";
        const modifiedUserInput = currentTurnParts[0]?.text
            ? [{ text: scholarshipContext + currentTurnParts[0].text }, ...currentTurnParts.slice(1)]
            : currentTurnParts;

        const currentApiContents = [...formattedHistory, { role: 'user', parts: modifiedUserInput }];

        // Updated system instruction with stricter domain focus
        const personaInstruction = "You are 'PakScholarship Assist', a specialized AI expert for Pakistani students seeking Master's scholarships abroad (UK, US, Germany, France, Italy, Finland, Japan, South Korea, China, Malaysia, Thailand, Indonesia, etc.). ONLY answer questions related to scholarships, eligibility, application processes, deadlines, and funding. If the user asks about unrelated topics, politely redirect them to ask about scholarships. Provide ACCURATE, FACTUAL, concise info. NEVER invent information. If details aren't known, state that clearly and suggest official sources.";

        const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash",
            safetySettings: [
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
            ]
        });

        console.log(`[${streamId}] Starting Gemini stream. History length: ${formattedHistory.length}. Current parts: ${modifiedUserInput.length}`);

        const resultStream = await model.generateContentStream({ contents: currentApiContents });

        let fullBotResponseText = '';
        for await (const chunk of resultStream.stream) {
            if (shouldStop || res.writableEnded) { break; }

            try {
                const safetyRatings = chunk.candidates?.[0]?.safetyRatings;
                if (safetyRatings?.some(r => r.blocked)) {
                    console.warn(`[${streamId}] Content blocked due to safety settings.`);
                    sendSseChunk({ type: 'error', content: 'Response blocked due to safety settings.' });
                    shouldStop = true;
                    break;
                }

                const chunkText = chunk.text ? chunk.text() : null;
                if (chunkText !== null) {
                    sendSseChunk({ type: 'chunk', content: chunkText });
                    fullBotResponseText += chunkText;
                }
            } catch (chunkError) {
                console.error(`[${streamId}] Error processing chunk:`, chunkError);
                sendSseChunk({ type: 'error', content: 'Error processing response chunk.' });
                shouldStop = true;
                break;
            }
        }

        if (!shouldStop && fullBotResponseText.trim()) {
            conversationHistory.push({ role: 'user', parts: currentTurnParts });
            conversationHistory.push({ role: 'model', parts: [{ text: fullBotResponseText }]});

            while (conversationHistory.length > MAX_HISTORY_TURNS * 2) {
                conversationHistory.shift();
            }
            console.log(`[${streamId}] Added turn to history. History length: ${conversationHistory.length}`);
        } else {
            console.log(`[${streamId}] Turn not added to history (stopped=${shouldStop}, emptyResponse=${!fullBotResponseText.trim()})`);
        }

        if (!res.writableEnded) {
            if (shouldStop) {
                sendSseChunk({ type: 'info', content: 'Stream stopped.' });
            } else {
                console.log(`[${streamId}] Stream finished naturally.`);
                sendSseChunk({ type: 'done', content: 'Stream finished.' });
            }
        }

    } catch (error) {
        console.error(`[${streamId}] ERROR during streaming request:`, error);
        if (!res.writableEnded) {
            try {
                const errorMessage = error.message || 'An error occurred on the server during streaming.';
                sendSseChunk({ type: 'error', content: errorMessage });
            } catch (sseError) {
                console.error(`[${streamId}] Failed to send error via SSE:`, sseError);
            }
        }
    } finally {
        console.log(`[${streamId}] Cleaning up stream resources.`);
        cleanupTempFile(streamData.tempFilePath, streamId);
        if (activeStreams.has(streamId)) { activeStreams.delete(streamId); }
        if (!res.writableEnded) { res.end(); }
        console.log(`[${streamId}] SSE connection resources cleaned up.`);
    }
});

// --- Route to STOP an active stream ---
app.post('/stop/:streamId', (req, res) => {
    const { streamId } = req.params;
    const streamData = activeStreams.get(streamId);

    if (streamData && streamData.status === 'streaming') {
        console.log(`[${streamId}] Received stop request via API.`);
        if (typeof streamData.stop === 'function') {
            streamData.stop();
        }
        res.status(200).send({ message: 'Stop signal processed.' });
    } else {
        console.log(`[${streamId}] Received stop request for invalid or non-streaming ID.`);
        res.status(404).send({ error: 'Stream not found or not actively streaming.' });
    }
});

// --- Serve the main HTML file for the root URL ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Error Handling Middleware ---
app.use((err, req, res, next) => {
    console.error("Unhandled Error:", err.stack || err);
    res.status(500).send('Something broke on the server!');
});

// --- Start Server ---
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});