import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import crypto from 'crypto';

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

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_PREFIX = { image: 'image/', sound: 'audio/' };

// Files are buffered in memory, so the size cap is what keeps a large upload from
// exhausting the server's RAM. The per-type image limit is checked in the route.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_AUDIO_BYTES, files: 2, fields: 10, fieldSize: 10 * 1024 },
    fileFilter: (req, file, callback) => {
        const prefix = ALLOWED_MIME_PREFIX[file.fieldname];
        if (prefix && file.mimetype.startsWith(prefix)) return callback(null, true);
        callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
    },
});

// Write endpoints require the ADMIN_TOKEN, sent as "Authorization: Bearer <token>".
// Runs before multer so unauthenticated uploads are rejected before being buffered.
const adminToken = process.env.ADMIN_TOKEN || '';
const requireAdmin = (req, res, next) => {
    if (!adminToken) {
        console.error('[auth] ADMIN_TOKEN is not set; rejecting write request');
        return res.status(503).json({ message: 'Adding animals is disabled on this server' });
    }
    const supplied = (req.headers.authorization || '').replace(/^Bearer /, '');
    const expectedHash = crypto.createHash('sha256').update(adminToken).digest();
    const suppliedHash = crypto.createHash('sha256').update(supplied).digest();
    if (!crypto.timingSafeEqual(expectedHash, suppliedHash)) {
        console.warn(`[auth] Rejected write from ${req.ip} with ${supplied ? 'wrong' : 'no'} admin password`);
        return res.status(401).json({ message: 'Incorrect admin password' });
    }
    next();
};

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
        console.error('Error fetching animals:', err);
        res.status(500).json({ message: 'Could not load animals' });
    }
});

app.post('/api/animals', requireAdmin, upload.fields([{ name: 'image', maxCount: 1 }, { name: 'sound', maxCount: 1 }]), async (req, res) => {
    try {
        const { name, category, habitat, facts, description } = req.body;
        const imageFile = req.files?.image?.[0];
        const soundFile = req.files?.sound?.[0];

        // Only assets uploaded through this server are accepted; arbitrary URLs from the
        // request body are never stored.
        if (!imageFile || !soundFile) {
            return res.status(400).json({ message: 'Both an image file and a sound file are required' });
        }
        if (imageFile.size > MAX_IMAGE_BYTES) {
            return res.status(400).json({ message: `Image must be ${MAX_IMAGE_BYTES / 1024 / 1024} MB or smaller` });
        }

        // Validate before uploading so a rejected animal doesn't leave orphaned Cloudinary assets.
        const newAnimal = new Animal({ name, category, habitat, facts, description: description || facts });
        await newAnimal.validate();
        if (await Animal.exists({ name: newAnimal.name })) {
            return res.status(409).json({ message: 'An animal with that name already exists' });
        }

        const imageResult = await uploadToCloudinary(imageFile.buffer, 'images', 'image');
        const soundResult = await uploadToCloudinary(soundFile.buffer, 'audio', 'video'); // Cloudinary stores audio under the 'video' resource type
        newAnimal.image = { url: imageResult.secure_url, public_id: imageResult.public_id };
        newAnimal.audio = { url: soundResult.secure_url, public_id: soundResult.public_id };

        const savedAnimal = await newAnimal.save();
        res.status(201).json(savedAnimal);
    } catch (err) {
        console.error('Error adding animal:', err);
        if (err.name === 'ValidationError' || err.name === 'CastError') {
            return res.status(400).json({ message: 'Invalid animal details. Check the name and category.' });
        }
        if (err.code === 11000) {
            return res.status(409).json({ message: 'An animal with that name already exists' });
        }
        res.status(500).json({ message: 'Could not add the animal. Please try again.' });
    }
});

app.get('/', (req, res) => {
    res.send('Sensory Safari API is running');
});

// The Cloudinary ping uses the rate-limited Admin API (500 calls/hour), so its result is
// cached rather than letting public /api/health traffic spend that quota.
const CLOUDINARY_PING_TTL_MS = 60 * 1000;
let cloudinaryPing = { checkedAt: 0, reachable: false };
const checkCloudinary = async () => {
    if (Date.now() - cloudinaryPing.checkedAt < CLOUDINARY_PING_TTL_MS) return cloudinaryPing.reachable;
    try {
        await cloudinary.api.ping();
        cloudinaryPing = { checkedAt: Date.now(), reachable: true };
    } catch (err) {
        console.error('[health] Cloudinary ping failed:', err.error?.message || err.message);
        cloudinaryPing = { checkedAt: Date.now(), reachable: false };
    }
    return cloudinaryPing.reachable;
};

// One-stop check of every dependency the frontend needs: open /api/health in a browser.
// Details of failures go to the server log, not the public response.
const MONGO_STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'];
app.get('/api/health', async (req, res) => {
    const health = {
        mongo: MONGO_STATES[mongoose.connection.readyState] || 'unknown',
        animalCount: null,
        cloudinaryReachable: await checkCloudinary(),
    };

    if (health.mongo === 'connected') {
        health.animalCount = await Animal.countDocuments().catch(err => {
            console.error('[health] Counting animals failed:', err.message);
            return null;
        });
    }

    const ok = health.mongo === 'connected' && health.cloudinaryReachable;
    res.status(ok ? 200 : 503).json(health);
});

// Upload limit/type errors from multer become 400s; anything else is logged and hidden.
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        const message = err.code === 'LIMIT_FILE_SIZE'
            ? `Files must be ${MAX_AUDIO_BYTES / 1024 / 1024} MB or smaller`
            : 'Upload one image file (image) and one audio file (sound)';
        return res.status(400).json({ message });
    }
    console.error('Unhandled error:', err);
    res.status(500).json({ message: 'Something went wrong' });
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
    console.log('[config] ADMIN_TOKEN set:', Boolean(adminToken), adminToken ? '' : '(adding animals is disabled)');
    console.log('[config] Cloudinary cloud:', process.env.CLOUDINARY_CLOUD_NAME || '(not set)',
        '| api key set:', Boolean(process.env.CLOUDINARY_API_KEY),
        '| api secret set:', Boolean(process.env.CLOUDINARY_API_SECRET));
});
