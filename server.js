const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const downloadStatus = {};

function isValidYouTubeUrl(url) {
    const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube|youtu|youtube-nocookie)\.(com|be)\/(watch\?v=|embed\/|v\/|.+\?v=)?([^&=%\?]{11})/;
    return youtubeRegex.test(url);
}

function getVideoId(url) {
    const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
}

function sanitizeFilename(filename) {
    return filename.replace(/[^\w\s-]/gi, '').replace(/\s+/g, '_').substring(0, 100);
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/video-info', async (req, res) => {
    try {
        const { url } = req.body;
        
        if (!url || !isValidYouTubeUrl(url)) {
            return res.status(400).json({ 
                success: false, 
                error: 'URL invalid pentru YouTube' 
            });
        }

        const videoId = getVideoId(url);
        if (!videoId) {
            return res.status(400).json({ 
                success: false, 
                error: 'Nu s-a putut extrage ID-ul videoclipului' 
            });
        }

        // Folosește API-ul YouTube v3
        const apiKey = 'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc';
        const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${videoId}&key=${apiKey}`;
        
        const response = await axios.get(apiUrl);
        const data = response.data;
        
        if (!data.items || data.items.length === 0) {
            return res.status(404).json({ 
                success: false, 
                error: 'Videoclipul nu a fost găsit sau este privat' 
            });
        }
        
        const video = data.items[0];
        const snippet = video.snippet;
        const statistics = video.statistics;
        
        // Convertește durata din format ISO 8601
        const duration = video.contentDetails.duration;
        const match = duration.match(/PT(\d+H)?(\d+M)?(\d+S)?/);
        const hours = (match[1] || '').replace('H', '');
        const minutes = (match[2] || '').replace('M', '');
        const seconds = (match[3] || '').replace('S', '');
        
        const totalSeconds = 
            (parseInt(hours) || 0) * 3600 + 
            (parseInt(minutes) || 0) * 60 + 
            (parseInt(seconds) || 0);
        
        res.json({
            success: true,
            info: {
                title: snippet.title,
                author: snippet.channelTitle,
                lengthSeconds: totalSeconds,
                viewCount: parseInt(statistics.viewCount) || 0,
                description: snippet.description ? snippet.description.substring(0, 200) + '...' : 'Fără descriere',
                thumbnail: snippet.thumbnails.maxres ? snippet.thumbnails.maxres.url : 
                          snippet.thumbnails.high ? snippet.thumbnails.high.url : 
                          snippet.thumbnails.default.url,
                qualities: ['1080p', '720p', '480p', '360p', '240p']
            }
        });
        
    } catch (error) {
        console.error('Eroare la obținerea informațiilor:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Nu s-au putut obține informațiile despre videoclip' 
        });
    }
});

app.post('/api/download', async (req, res) => {
    try {
        const { url, quality } = req.body;
        
        if (!url || !isValidYouTubeUrl(url)) {
            return res.status(400).json({ 
                success: false, 
                error: 'URL invalid pentru YouTube' 
            });
        }

        const downloadId = uuidv4();
        downloadStatus[downloadId] = {
            status: 'processing',
            progress: 0,
            filename: null,
            error: null
        };

        // Pornește descărcarea async
        processDownload(downloadId, url, quality).catch(error => {
            console.error('Eroare la procesarea descărcării:', error);
            downloadStatus[downloadId].status = 'error';
            downloadStatus[downloadId].error = error.message;
        });
        
        res.json({
            success: true,
            downloadId: downloadId,
            message: 'Descărcarea a început'
        });
        
    } catch (error) {
        console.error('Eroare la începerea descărcării:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Eroare la începerea descărcării' 
        });
    }
});

app.get('/api/download-status/:downloadId', (req, res) => {
    const { downloadId } = req.params;
    const status = downloadStatus[downloadId];
    
    if (!status) {
        return res.status(404).json({ 
            success: false, 
            error: 'Descărcare negăsită' 
        });
    }
    
    res.json({
        success: true,
        status: status
    });
});

app.get('/api/file/:downloadId', (req, res) => {
    const { downloadId } = req.params;
    const status = downloadStatus[downloadId];
    
    if (!status || status.status !== 'completed') {
        return res.status(404).json({ 
            success: false, 
            error: 'Fișier negăsit sau descărcare incompletă' 
        });
    }
    
    const filePath = path.join(__dirname, 'downloads', status.filename);
    
    if (fs.existsSync(filePath)) {
        res.download(filePath, status.filename, (err) => {
            if (err) {
                console.error('Eroare la trimiterea fișierului:', err);
            }
            // Șterge fișierul după 5 minute
            setTimeout(() => {
                try {
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                    }
                    delete downloadStatus[downloadId];
                } catch (e) {
                    console.error('Eroare la ștergerea fișierului:', e);
                }
            }, 5 * 60 * 1000);
        });
    } else {
        res.status(404).json({ 
            success: false, 
            error: 'Fișierul nu a fost găsit' 
        });
    }
});

async function processDownload(downloadId, url, quality) {
    try {
        // Creează directorul de descărcări
        const downloadsDir = path.join(__dirname, 'downloads');
        if (!fs.existsSync(downloadsDir)) {
            fs.mkdirSync(downloadsDir, { recursive: true });
        }
        
        downloadStatus[downloadId].status = 'fetching_info';
        downloadStatus[downloadId].progress = 10;
        
        const videoId = getVideoId(url);
        if (!videoId) {
            throw new Error('ID videoclip invalid');
        }
        
        // Obține informațiile video cu YouTube API
        const apiKey = 'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc';
        const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${apiKey}`;
        
        const response = await axios.get(apiUrl);
        const videoData = response.data;
        
        if (!videoData.items || videoData.items.length === 0) {
            throw new Error('Videoclipul nu a fost găsit');
        }
        
        const videoDetails = videoData.items[0].snippet;
        const sanitizedTitle = sanitizeFilename(videoDetails.title);
        
        downloadStatus[downloadId].status = 'downloading';
        downloadStatus[downloadId].progress = 25;
        
        // Folosește API extern pentru descărcare
        const downloadApiUrl = 'https://ytmp3.ch/api/convert';
        const downloadData = {
            url: url,
            quality: quality === 'audio' ? 'mp3' : 'mp4',
            format: quality === 'audio' ? 'mp3' : 'mp4'
        };
        
        downloadStatus[downloadId].progress = 50;
        
        // Simulare pentru demonstrație - în realitate ai nevoie de un API real
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        const filename = quality === 'audio' ? 
            `${sanitizedTitle}_${downloadId}.mp3` : 
            `${sanitizedTitle}_${quality}_${downloadId}.mp4`;
        
        const filePath = path.join(downloadsDir, filename);
        
        // Pentru demo, creez un fișier cu informații
        const fileContent = `YouTube Video Download Demo
        
Videoclip: ${videoDetails.title}
URL: ${url}
Calitate: ${quality}
Download ID: ${downloadId}
Timestamp: ${new Date().toISOString()}

Acesta este un fișier demonstrativ.
Pentru descărcare reală, este necesar un API de descărcare extern valid.

API-uri recomandate:
- RapidAPI YouTube Downloader
- Y2mate API
- Cobalt API
- SaveTube API

Informații tehnice:
- Server: Render.com
- Runtime: Node.js 18
- Framework: Express.js`;
        
        fs.writeFileSync(filePath, fileContent);
        
        downloadStatus[downloadId].progress = 100;
        downloadStatus[downloadId].status = 'completed';
        downloadStatus[downloadId].filename = filename;
        
        console.log(`✅ Demo descărcare completă: ${filename}`);
        
    } catch (error) {
        console.error('Eroare la procesarea descărcării:', error);
        downloadStatus[downloadId].status = 'error';
        downloadStatus[downloadId].error = `Eroare la procesarea videoclipului: ${error.message}`;
        throw error;
    }
}

// Cleanup periodic pentru fișierele vechi
setInterval(() => {
    const downloadsDir = path.join(__dirname, 'downloads');
    if (!fs.existsSync(downloadsDir)) return;
    
    try {
        const files = fs.readdirSync(downloadsDir);
        const now = Date.now();
        
        files.forEach(file => {
            const filePath = path.join(downloadsDir, file);
            const stats = fs.statSync(filePath);
            const fileAge = now - stats.mtime.getTime();
            
            // Șterge fișierele mai vechi de 30 minute
            if (fileAge > 30 * 60 * 1000) {
                try {
                    fs.unlinkSync(filePath);
                    console.log(`🗑️ Fișierul vechi ${file} a fost șters`);
                } catch (e) {
                    console.error(`Eroare la ștergerea fișierului ${file}:`, e);
                }
            }
        });
    } catch (error) {
        console.error('Eroare la cleanup:', error);
    }
}, 10 * 60 * 1000); // La fiecare 10 minute

app.listen(PORT, () => {
    console.log(`🚀 YouTube Downloader API rulează pe portul ${PORT}`);
    console.log(`📁 Fișierele se salvează în: ${path.join(__dirname, 'downloads')}`);
    console.log(`🌐 Server disponibil la: http://localhost:${PORT}`);
    console.log(`⚠️  Folosind YouTube API pentru informații și demo pentru descărcare`);
});
