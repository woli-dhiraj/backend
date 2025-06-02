const express = require('express');
const cors = require('cors');
const app = express();

// CORS Configuration
app.use(cors({
    origin: 'http://localhost:5173', // Vite dev server
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true // Enable if you're using cookies/sessions
}));

// Parse JSON bodies
app.use(express.json());

// Your routes here
app.get('/api/movies', (req, res) => {
    // Example route
    res.json({ message: 'Movies API working!' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
}); 