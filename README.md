# EcoPoints server

1. Put this folder on GitHub (server.js, package.json, public/).
2. On render.com: New > Web Service > connect the repo.
   Build command: npm install     Start command: node server.js
   Environment variable: API_KEY = (a long random secret)
3. Open the Render URL: that is your website. Register a card ID with a name and PIN.
4. In the ESP32 code (sketch_v6): set API_BASE to the Render URL, API_KEY to the same secret,
   USE_SERVER = true.

Note: free hosts wipe data.json when they restart. For lasting data, add a Render disk
(paid) or move the data to a hosted database.
