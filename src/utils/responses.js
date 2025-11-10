// Standard API response helpers

export const success = (data, message = 'Success') => ({
  success: true,
  message,
  data,
  timestamp: new Date().toISOString()
});

export const error = (message, code = 500, details = null) => ({
  success: false,
  error: message,
  code,
  details,
  timestamp: new Date().toISOString()
});

export const paginated = (items, pagination) => ({
  success: true,
  results: items,
  pagination,
  timestamp: new Date().toISOString()
});

// CORS headers for Vercel
export const setCorsHeaders = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
};

// Handle OPTIONS requests
export const handleCors = (req, res) => {
  if (req.method === 'OPTIONS') {
    setCorsHeaders(res);
    return res.status(200).end();
  }
  setCorsHeaders(res);
  return false;
};