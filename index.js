require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const authRoutes = require('./routes/auth');
const axios = require('axios');

const app = express();

// Environment variables with defaults
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/movie-app';
const JWT_SECRET = process.env.JWT_SECRET || 'mysupersecretkey123';
const PORT = process.env.PORT || 5000;
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

// Make JWT_SECRET available globally
global.JWT_SECRET = JWT_SECRET;

// CORS configuration
const corsOptions = {
  origin: CLIENT_URL,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  exposedHeaders: ['Set-Cookie'],
  optionsSuccessStatus: 200
};

// Middleware order is important
app.use(cors(corsOptions)); // CORS should be first
app.use(express.json());
app.use(cookieParser());

// Enable pre-flight requests for all routes
app.options('*', cors(corsOptions));

// Test route
app.get('/api/test', (req, res) => {
  res.json({ message: 'Backend is working!' });
});

// Connect to MongoDB with updated options
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
  .then(() => console.log('MongoDB Connected Successfully'))
  .catch(err => console.error('MongoDB connection error:', err));

// Routes
app.use('/api/auth', authRoutes);

// Update the anime API endpoints
const ANIME_API_URL = 'https://api.jikan.moe/v4';

// In-memory cache with expiration
const cache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
const RATE_LIMIT_DELAY = 1000; // 1 second delay between requests

// Queue for managing API requests
let lastRequestTime = 0;
const queue = [];
let isProcessingQueue = false;

const processQueue = async () => {
  if (isProcessingQueue || queue.length === 0) return;
  
  isProcessingQueue = true;
  
  while (queue.length > 0) {
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;
    
    if (timeSinceLastRequest < RATE_LIMIT_DELAY) {
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY - timeSinceLastRequest));
    }
    
    const { endpoint, res, resolve: queueResolve } = queue.shift();
    
    try {
      const response = await axios.get(`${ANIME_API_URL}${endpoint}`, {
        timeout: 10000,
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });
      
      lastRequestTime = Date.now();
      cache.set(endpoint, {
        data: response.data,
        timestamp: Date.now()
      });
      
      console.log('Response received:', {
        endpoint,
        status: response.status,
        dataLength: response.data?.data?.length || 0
      });
      
      queueResolve(response.data);
      res.json(response.data);
    } catch (error) {
      console.error('Error fetching anime:', {
        endpoint,
        message: error.message,
        status: error.response?.status,
        data: error.response?.data
      });
      
      if (error.response?.status === 429) {
        // If rate limited, put the request back in the queue
        queue.unshift({ endpoint, res, resolve: queueResolve });
        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY));
        continue;
      }
      
      res.status(error.response?.status || 500).json({
        error: 'Failed to fetch anime data',
        message: error.message
      });
      queueResolve(null);
    }
  }
  
  isProcessingQueue = false;
};

// Simple proxy middleware with caching and rate limiting
const proxyRequest = async (req, res, endpoint) => {
  try {
    console.log('Request received for:', endpoint);
    
    // Check cache first
    const cached = cache.get(endpoint);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
      console.log('Returning cached data for:', endpoint);
      return res.json(cached.data);
    }
    
    // Add request to queue
    await new Promise(resolve => {
      queue.push({ endpoint, res, resolve });
      processQueue();
    });
  } catch (error) {
    console.error('Error in proxy request:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

// Updated anime routes
app.get('/api/trending', (req, res) => proxyRequest(req, res, '/top/anime?filter=airing&limit=24'));
app.get('/api/recent', (req, res) => proxyRequest(req, res, '/seasons/now?limit=24'));
app.get('/api/search/:query', (req, res) => proxyRequest(req, res, `/anime?q=${encodeURIComponent(req.params.query)}&limit=24`));
app.get('/api/info/:id', (req, res) => proxyRequest(req, res, `/anime/${req.params.id}/full`));

// Add video streaming endpoints with Gogoanime API
const GOGOANIME_API_URL = 'https://consumet-api.herokuapp.com/anime/gogoanime';

// Helper function to get anime info from Gogoanime
const getGogoanimeInfo = async (title) => {
  try {
    console.log('Searching for anime:', title);
    
    // Clean up the title for search
    const searchTitle = title
      .toLowerCase()
      .replace(/\([^)]*\)/g, '') // Remove anything in parentheses
      .replace(/season \d+/gi, '') // Remove "season X"
      .replace(/part \d+/gi, '') // Remove "part X"
      .trim()
      .replace(/\s+/g, ' ');
    
    console.log('Cleaned search title:', searchTitle);
    
    // Search for the anime
    const searchResponse = await axios.get(`${GOGOANIME_API_URL}/search/${encodeURIComponent(searchTitle)}`);
    console.log('Search response:', {
      query: searchTitle,
      resultsCount: searchResponse.data.results?.length || 0,
      firstResult: searchResponse.data.results?.[0]
    });

    if (!searchResponse.data.results || searchResponse.data.results.length === 0) {
      throw new Error(`Anime not found on Gogoanime: ${searchTitle}`);
    }

    // Get the first result
    const animeInfo = searchResponse.data.results[0];
    return animeInfo;
  } catch (error) {
    console.error('Error in getGogoanimeInfo:', {
      title,
      error: error.message,
      response: error.response?.data
    });
    throw error;
  }
};

// Add video streaming endpoints
app.get('/api/watch/:id/:episode', async (req, res) => {
  try {
    const { id } = req.params;
    const episode = parseInt(req.params.episode) || 1;

    console.log('Fetching video for:', { id, episode });

    // First get the MAL anime info
    const malResponse = await axios.get(`${ANIME_API_URL}/anime/${id}/full`);
    const malAnime = malResponse.data.data;
    
    console.log('MAL anime info:', {
      id: malAnime.mal_id,
      title: malAnime.title,
      episodes: malAnime.episodes
    });

    // Get Gogoanime info
    const gogoanimeInfo = await getGogoanimeInfo(malAnime.title);
    console.log('Gogoanime info:', gogoanimeInfo);
    
    // Get episode sources
    const episodeId = `${gogoanimeInfo.id}-episode-${episode}`;
    console.log('Fetching episode:', episodeId);
    
    const sourceResponse = await axios.get(`${GOGOANIME_API_URL}/watch/${episodeId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    console.log('Source response:', {
      episodeId,
      sourcesCount: sourceResponse.data.sources?.length || 0,
      hasHeaders: !!sourceResponse.data.headers
    });

    if (!sourceResponse.data.sources || sourceResponse.data.sources.length === 0) {
      throw new Error(`No video sources found for episode ${episode}`);
    }

    res.json({
      sources: sourceResponse.data.sources,
      headers: sourceResponse.data.headers
    });
  } catch (error) {
    console.error('Error in /api/watch:', {
      id: req.params.id,
      episode: req.params.episode,
      error: error.message,
      response: error.response?.data
    });
    
    res.status(500).json({
      error: 'Failed to fetch video',
      message: error.message,
      details: error.response?.data
    });
  }
});

app.get('/api/episodes/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // First get the MAL anime info
    const malResponse = await axios.get(`${ANIME_API_URL}/anime/${id}/full`);
    const malAnime = malResponse.data.data;

    // Get Gogoanime info
    const gogoanimeInfo = await getGogoanimeInfo(malAnime.title);
    
    // Get episode list
    const episodesResponse = await axios.get(`${GOGOANIME_API_URL}/info/${gogoanimeInfo.id}`);
    
    res.json(episodesResponse.data);
  } catch (error) {
    console.error('Error fetching episodes:', error);
    res.status(500).json({
      error: 'Failed to fetch episodes',
      message: error.message
    });
  }
});

// Global error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err.stack);
  res.status(err.status || 500).json({ 
    success: false,
    message: err.message || 'Something went wrong!',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Handle 404 routes
app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    message: 'Route not found' 
  });
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
  console.log(`Accepting requests from: ${CLIENT_URL}`);
}); 