import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
// FRONTEND_URL may be a comma-separated list. Trailing slashes are stripped because the
// browser's Origin header never has one, so "https://site.com/" would never match.
const normalizeOrigin = (origin) => origin.trim().replace(/\/+$/, '');
const allowedOrigins = (process.env.FRONTEND_URL || '')
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean);

// Log every request with its Origin so CORS and routing problems show up in the host's logs.
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms origin=${req.headers.origin || '-'}`);
    });
    next();
});

app.use(cors({
    origin: (origin, callback) => {
        // Requests without an Origin (curl, server-to-server, same-origin GETs) aren't subject to CORS.
        if (!origin || allowedOrigins.includes(normalizeOrigin(origin))) {
            return callback(null, true);
        }
        console.warn(`[cors] Blocked origin "${origin}". Allowed: ${JSON.stringify(allowedOrigins)}. Update FRONTEND_URL if this is your site.`);
        callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

import Animal from './models/Animal.js';

const upload = multer({ storage: multer.memoryStorage() });
import { v2 as cloudinary } from 'cloudinary';

// Configure Cloudinary (ensure these are set in .env)
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

const uploadToCloudinary = (buffer, folder, resourceType = 'image') => {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            { folder: `sensory-safari/${folder}`, resource_type: resourceType },
            (error, result) => {
                if (error) return reject(error);
                resolve(result);
            }
        );
        uploadStream.end(buffer);
    });
};

// Routes
app.get('/api/animals', async (req, res) => {
    try {
        const animals = await Animal.find();
        res.json(animals);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.post('/api/animals', upload.fields([{ name: 'image', maxCount: 1 }, { name: 'sound', maxCount: 1 }]), async (req, res) => {
    try {
        const { name, category, habitat, facts, description } = req.body;
        let imageUrl = req.body.image; // Could be a URL string
        let imagePublicId = '';
        let soundUrl = req.body.sound; // Could be a URL string
        let soundPublicId = '';

        // Handle Image Upload
        if (req.files['image']) {
            const result = await uploadToCloudinary(req.files['image'][0].buffer, 'images', 'image');
            imageUrl = result.secure_url;
            imagePublicId = result.public_id;
        }

        // Handle Audio Upload
        if (req.files['sound']) {
            const result = await uploadToCloudinary(req.files['sound'][0].buffer, 'audio', 'video'); // Audio uses 'video' resource_type often
            soundUrl = result.secure_url;
            soundPublicId = result.public_id;
        }

        const newAnimal = new Animal({
            name,
            category,
            habitat,
            facts,
            description: description || facts,
            image: {
                url: imageUrl,
                public_id: imagePublicId
            },
            audio: {
                url: soundUrl,
                public_id: soundPublicId
            }
        });

        const savedAnimal = await newAnimal.save();
        res.status(201).json(savedAnimal);
    } catch (err) {
        console.error('Error adding animal:', err);
        res.status(400).json({ message: err.message });
    }
});

app.get('/', (req, res) => {
    res.send('Sensory Safari API is running');
});

// One-stop check of every dependency the frontend needs: open /api/health in a browser.
const MONGO_STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'];
app.get('/api/health', async (req, res) => {
    const health = {
        mongo: MONGO_STATES[mongoose.connection.readyState] || 'unknown',
        animalCount: null,
        cloudinary: { cloudName: process.env.CLOUDINARY_CLOUD_NAME || null, reachable: false },
        allowedOrigins,
        requestOrigin: req.headers.origin || null,
    };

    if (health.mongo === 'connected') {
        health.animalCount = await Animal.countDocuments().catch(err => `error: ${err.message}`);
    }

    try {
        await cloudinary.api.ping();
        health.cloudinary.reachable = true;
    } catch (err) {
        health.cloudinary.error = err.error?.message || err.message;
    }

    const ok = health.mongo === 'connected' && health.cloudinary.reachable;
    res.status(ok ? 200 : 503).json(health);
});

const mongoUri = process.env.MONGODB_URI;

mongoose.connection.on('disconnected', () => console.warn('[mongo] Disconnected'));
mongoose.connection.on('error', err => console.error('[mongo] Connection error:', err.message));

mongoose.connect(mongoUri)
    .then(() => console.log('MongoDB connected'))
    .catch(err => console.error('[mongo] Initial connection failed:', err.message));

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log('[config] Allowed CORS origins:', allowedOrigins.length ? allowedOrigins : '(none, FRONTEND_URL is not set: browsers will be blocked)');
    console.log('[config] MONGODB_URI set:', Boolean(mongoUri));
    console.log('[config] Cloudinary cloud:', process.env.CLOUDINARY_CLOUD_NAME || '(not set)',
        '| api key set:', Boolean(process.env.CLOUDINARY_API_KEY),
        '| api secret set:', Boolean(process.env.CLOUDINARY_API_SECRET));
});
