# Sensory Safari Server

Backend REST API for the Sensory Safari web application — an interactive, autism-friendly animal learning platform for children.

Built with Node.js, Express, MongoDB, and Cloudinary.

---

## Tech Stack

| Technology  | Purpose                            |
| ----------- | ---------------------------------- |
| Express 5   | REST API framework                 |
| MongoDB     | Database (via Mongoose ODM)        |
| Cloudinary  | Image and audio file storage       |
---

## API Endpoints

### Health Check

| Method | Endpoint | Description             |
| ------ | -------- | ----------------------- |
| GET    | `/`      | API status confirmation |
| GET    | `/api/health` | Mongo state, animal count, Cloudinary reachability (503 if unhealthy) |

### Animals

| Method | Endpoint        | Description                                     |
| ------ | --------------- | ----------------------------------------------- |
| GET    | `/api/animals`  | Retrieve all animals                             |
| POST   | `/api/animals`  | Add a new animal (admin only, image & audio upload) |

### POST `/api/animals` — Request Body

Requires `Authorization: Bearer <ADMIN_TOKEN>` (401 otherwise, 503 if `ADMIN_TOKEN` is not configured).
Accepts `multipart/form-data` only.

| Field       | Type            | Required | Description                              |
| ----------- | --------------- | -------- | ---------------------------------------- |
| name        | String          | Yes      | Animal name (must be unique)             |
| category    | String          | No       | `wild`, `farm`, `birds`, or `insects`    |
| habitat     | String          | No       | Natural habitat description              |
| facts       | String          | No       | Interesting facts about the animal       |
| description | String          | No       | Detailed description (defaults to facts) |
| image       | File            | Yes      | Image file (`image/*`, max 5 MB)          |
| sound       | File            | Yes      | Audio file (`audio/*`, max 10 MB)         |

---

## Data Model

### Animal Schema

```javascript
{
    name:        { type: String, required: true, unique: true },
    category:    { type: String, enum: ['wild', 'farm', 'birds', 'insects'], default: 'wild' },
    habitat:     String,
    facts:       String,
    description: String,
    image: {
        url:       String,   
        public_id: String    
    },
    audio: {
        url:       String,
        public_id: String
    }
}
```

---

## Getting Started

### Prerequisites

- Node.js (v18+)
- MongoDB Atlas account
- Cloudinary account

### Installation

```bash
git clone <repository-url>
cd SensorySafari-Server
npm install
```

### Environment Variables

Copy the example and fill in your credentials:

```bash
cp .env.example .env
```

| Variable               | Description                          |
| ---------------------- | ------------------------------------ |
| PORT                   | Server port (default: 5000)          |
| MONGODB_URI            | MongoDB Atlas connection string      |
| CLOUDINARY_CLOUD_NAME  | Cloudinary cloud name                |
| CLOUDINARY_API_KEY     | Cloudinary API key                   |
| CLOUDINARY_API_SECRET  | Cloudinary API secret                |
| FRONTEND_URL           | Deployed frontend URL(s) for CORS, comma-separated |
| ADMIN_TOKEN            | Password required to add animals (adding is disabled if unset) |

### Run

```bash
# Development (with hot reload)
npm run dev

# Production
npm start
```

---

## Deployment (Render)

1. Push the repo to GitHub
2. Create a new **Web Service** on [Render](https://render.com)
3. Set the **Build Command** to `npm install`
4. Set the **Start Command** to `npm start`
5. Add all environment variables from the table above in Render's dashboard
6. Set `FRONTEND_URL` to your deployed frontend URL to enable CORS

---

## Project Structure

```
SensorySafari-Server/
├── index.js            # Express app, routes, Cloudinary config, CORS setup
├── models/
│   └── Animal.js       # Mongoose schema and model
├── scripts/            # Utility scripts (migration, debugging)
├── .env.example        # Environment variable template
├── package.json
└── README.md
```

---
