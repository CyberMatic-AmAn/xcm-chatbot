const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

// Middleware
app.use(express.json());

// Strict CORS: Allow only frontend URL (plus local dev variations)
const allowedOrigins = [
  FRONTEND_URL,
  "https://xcm-devfolio.vercel.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. mobile apps, curl, or same-origin)
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`CORS blocked request from origin: ${origin}`));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Rate Limiting: Max 10 requests per 5 minutes per IP
const chatRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 10, // 10 requests per 5 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many requests. Please wait a few minutes before asking more questions.",
  },
});

// Exact system persona instructions for xCM AI
const SYSTEM_INSTRUCTION = `You are an exclusive AI assistant representing xCM. Your strict rule is to ONLY answer questions related to xCM. You must refuse to answer general knowledge, coding help, or unrelated queries. If asked what AI model you are, you must answer: 'I am a custom AI created by xCM.' 

**xCM Context to use for answers:** xCM is a developer specializing in Ai & Data Science. Notable projects include a javascript based programming language, an Agentic-assistant for interview help and coding assistance, a real time trade sequence evaluation system and a multi-agent self-learning system. He favors morning coffee and evening tea, and to fuel up special place in heart for sweets. Keep responses concise, professional, and slightly witty.`;

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "healthy", service: "xCM Backend" });
});

// Main chat endpoint
app.post("/api/chat", chatRateLimiter, async (req, res) => {
  try {
    const { message, history } = req.body;

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "A valid message is required." });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === "your_api_key_here") {
      return res.status(503).json({
        error: "Ai is not configured.",
      });
    }

    // Candidate models to try in order (resilient against temporary 503 high-demand spikes)
    const configuredModel = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
    const candidateModels = Array.from(
      new Set([configuredModel, "gemini-3.5-flash-lite", "gemini-2.5-flash", "gemini-3.5-flash"].filter(Boolean))
    );

    const genAI = new GoogleGenerativeAI(apiKey);
    let reply = "";
    let lastError = null;

    // Format and validate conversation history for Gemini:
    // 1. Must start with role 'user' (strip any leading model greeting)
    // 2. Roles must strictly alternate: user -> model -> user -> model
    // 3. Must end with 'model' so that chat.sendMessage(message) is the next 'user' turn
    let geminiHistory = [];
    if (Array.isArray(history) && history.length > 0) {
      const validTurns = history
        .filter((item) => item && typeof item.text === "string" && item.text.trim())
        .map((item) => ({
          role: item.role === "ai" || item.role === "model" ? "model" : "user",
          parts: [{ text: item.text.trim() }],
        }));

      const firstUserIndex = validTurns.findIndex((t) => t.role === "user");
      if (firstUserIndex !== -1) {
        let expectedRole = "user";
        for (let i = firstUserIndex; i < validTurns.length; i++) {
          if (validTurns[i].role === expectedRole) {
            geminiHistory.push(validTurns[i]);
            expectedRole = expectedRole === "user" ? "model" : "user";
          }
        }
      }

      if (geminiHistory.length > 0 && geminiHistory[geminiHistory.length - 1].role === "user") {
        geminiHistory.pop();
      }
    }

    // Try candidate models in order until one succeeds
    for (const modelName of candidateModels) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          systemInstruction: SYSTEM_INSTRUCTION,
        });

        const chat = model.startChat({
          history: geminiHistory,
        });

        const result = await chat.sendMessage(message.trim());
        const response = await result.response;
        reply = response.text();
        if (reply) break;
      } catch (err) {
        lastError = err;
        console.warn(`[xCM Backend] Model ${modelName} returned error: ${err.message}. Trying fallback...`);
      }
    }

    if (!reply && lastError) {
      throw lastError;
    }

    return res.json({ reply });
  } catch (error) {
    console.error("Error generating Gemini AI response:", error);
    return res.status(500).json({
      error: error.message || "An error occurred while communicating with the AI model. Please try again.",
      details: error.message,
    });
  }
});

app.listen(PORT, () => {
  // console.log(`[xCM Backend] AI Chatbot Server running on port ${PORT}`);
  // console.log(`[xCM Backend] Allowed Frontend Origin: ${FRONTEND_URL}`);
  console.log("server started.....");
});
