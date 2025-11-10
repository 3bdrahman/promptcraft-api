/**
 * PromptCraft API Server
 * Express backend for authentication, templates, contexts, and teams
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import apiRouter from './routes/index.js';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const NODE_ENV = process.env.NODE_ENV || 'development';

// CORS Configuration
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
      'http://localhost:3000',
      'http://localhost:3001',
      'chrome-extension://*'
    ];

    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);

    // Check if origin is allowed or matches chrome-extension pattern
    if (allowedOrigins.some(allowed =>
      allowed === origin ||
      (allowed.includes('chrome-extension') && origin.startsWith('chrome-extension://'))
    )) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging
app.use((req, res, next) => {
  console.log(`📡 [${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
    version: '1.0.0'
  });
});

// API Routes
app.use('/api', apiRouter);

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: {
      message: `Route ${req.method} ${req.path} not found`,
      code: 404
    }
  });
});

// Error Handler
app.use((err, req, res, next) => {
  console.error('❌ [Server Error]:', err);

  res.status(err.status || 500).json({
    success: false,
    error: {
      message: err.message || 'Internal server error',
      code: err.status || 500,
      ...(NODE_ENV === 'development' && { stack: err.stack })
    }
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║                                                       ║
║   🚀 PromptCraft API Server                          ║
║                                                       ║
║   Environment: ${NODE_ENV.padEnd(36)} ║
║   Port:        ${PORT.toString().padEnd(36)} ║
║   URL:         http://localhost:${PORT}${' '.repeat(24)}║
║                                                       ║
║   Health:      http://localhost:${PORT}/health${' '.repeat(17)}║
║   API Docs:    http://localhost:${PORT}/api${' '.repeat(19)}║
║                                                       ║
╚═══════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, shutting down gracefully...');
  process.exit(0);
});
