const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'distill-landing.html'));
});

app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'distill-app.html'));
});

app.listen(PORT, () => {
  console.log(`Distill running on port ${PORT}`);
});
