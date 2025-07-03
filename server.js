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

// Cobalt API endpoint
const COBALT_API = 'https://co.wuk.sh/api/json';

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

        // Folosește Cobalt API pentru informații
        const cobaltResponse = await axios.post(COBALT_API, {
            url: url,
            downloadMode: 'auto'
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        if (cobaltResponse.data && cobaltResponse.data.status === 'success') {
            // Dacă Cobalt returnează info, folosește-le
            const videoId = getVideoId(url);
            
            res.json({
                success: true,
                info: {
                    title: `YouTube Video ${videoId}`,
                    author: 'YouTube Channel',
                    lengthSeconds: 0,
                    viewCount: 0,
                    description: 'Video disponibil pentru descărcare via Cobalt API',
                    thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
                    qualities: ['1080p', '720p', '480p', '360p', '240p']
                }
            });
        } else {
            throw new Error('Cobalt nu poate accesa videoclipul');
        }
        
    } catch (error) {
        console.error('Eroare la obținerea informațiilor:', error);
        
        // Fallback cu informații de bază
        const videoId = getVideoId(req.body.url);
        if (videoId) {
            res.json({
                success: true,
                info: {
                    title: `YouTube Video ${videoId}`,
                    author: 'YouTube Channel',
                    lengthSeconds: 0,
                    viewCount: 0,
                    description: 'Video disponibil pentru descărcare',
                    thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
                    qualities: ['1080p', '720p', '480p', '360p', '240p']
                }
            });
        } else {
            res.status(500).json({ 
                success: false, 
                error: 'Nu s-au putut obține informațiile despre videoclip' 
            });
        }
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
            error: null,
            downloadUrl: null
        };

        // Procesează descărcarea cu Cobalt API
        processDownloadWithCobalt(downloadId, url, quality).catch(error => {
            console.error('Eroare la procesarea descărcării:', error);
            downloadStatus[downloadId].status = 'error';
            downloadStatus[downloadId].error = error.message;
        });
        
        res.json({
            success: true,
            downloadId: downloadId,
            message: 'Descărcarea a început prin Cobalt API'
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

app.get('/api/file/:downloadId', async (req, res) => {
    const { downloadId } = req.params;
    const status = downloadStatus[downloadId];
    
    if (!status || status.status !== 'completed') {
        return res.status(404).json({ 
            success: false, 
            error: 'Descărcare incompletă' 
        });
    }
    
    try {
        if (status.downloadUrl) {
            // Redirect la URL-ul de descărcare de la Cobalt
            res.redirect(status.downloadUrl);
        } else if (status.filename) {
            // Sau servește fișierul local dacă există
            const filePath = path.join(__dirname, 'downloads', status.filename);
            if (fs.existsSync(filePath)) {
                res.download(filePath, status.filename);
            } else {
                res.status(404).json({ 
                    success: false, 
                    error: 'Fișierul nu a fost găsit' 
                });
            }
        } else {
            res.status(404).json({ 
                success: false, 
                error: 'Nu există link de descărcare' 
            });
        }
        
        // Cleanup după 10 minute
        setTimeout(() => {
            delete downloadStatus[downloadId];
        }, 10 * 60 * 1000);
        
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: 'Eroare la accesarea fișierului' 
        });
    }
});

async function processDownloadWithCobalt(downloadId, url, quality) {
    try {
        downloadStatus[downloadId].status = 'downloading';
        downloadStatus[downloadId].progress = 25;
        
        console.log(`🎬 Început descărcare Cobalt: ${url}`);
        
        // Configurează request-ul pentru Cobalt API
        let cobaltSettings = {
            url: url,
            downloadMode: 'auto',
            youtubeVideoFormat: 'mp4'
        };
        
        // Setări specifice pentru calitate
        if (quality === 'audio') {
            cobaltSettings.downloadMode = 'audio';
            cobaltSettings.youtubeAudioFormat = 'mp3';
        } else if (quality !== 'best') {
            // Pentru calități specifice (720p, 1080p, etc.)
            cobaltSettings.youtubeVideoQuality = quality;
        }
        
        downloadStatus[downloadId].progress = 50;
        
        // Apelează Cobalt API
        const response = await axios.post(COBALT_API, cobaltSettings, {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 30000 // 30 secunde timeout
        });
        
        downloadStatus[downloadId].progress = 75;
        
        console.log('Cobalt răspuns:', response.data);
        
        if (response.data && response.data.status === 'success') {
            downloadStatus[downloadId].progress = 90;
            
            if (response.data.url) {
                // URL direct de descărcare
                downloadStatus[downloadId].status = 'completed';
                downloadStatus[downloadId].progress = 100;
                downloadStatus[downloadId].downloadUrl = response.data.url;
                downloadStatus[downloadId].filename = `video_${downloadId}.${quality === 'audio' ? 'mp3' : 'mp4'}`;
                
                console.log(`✅ Descărcare completă via Cobalt: ${response.data.url}`);
            } else if (response.data.picker && response.data.picker.length > 0) {
                // Multiple opțiuni disponibile, alege prima
                const firstOption = response.data.picker[0];
                downloadStatus[downloadId].status = 'completed';
                downloadStatus[downloadId].progress = 100;
                downloadStatus[downloadId].downloadUrl = firstOption.url;
                downloadStatus[downloadId].filename = `video_${downloadId}.${quality === 'audio' ? 'mp3' : 'mp4'}`;
                
                console.log(`✅ Descărcare completă via Cobalt (picker): ${firstOption.url}`);
            } else {
                throw new Error('Cobalt nu a returnat URL de descărcare');
            }
        } else {
            throw new Error(`Cobalt API error: ${response.data?.text || 'Unknown error'}`);
        }
        
    } catch (error) {
        console.error('Eroare Cobalt API:', error);
        
        let errorMessage = 'Eroare la procesarea videoclipului';
        
        if (error.response) {
            console.error('Cobalt error response:', error.response.data);
            errorMessage = `Cobalt API error: ${error.response.data?.text || error.response.status}`;
        } else if (error.code === 'ECONNABORTED') {
            errorMessage = 'Timeout la procesarea videoclipului';
        }
        
        downloadStatus[downloadId].status = 'error';
        downloadStatus[downloadId].error = errorMessage;
        
        throw new Error(errorMessage);
    }
}

// Cleanup periodic
setInterval(() => {
    const now = Date.now();
    
    Object.keys(downloadStatus).forEach(downloadId => {
        const status = downloadStatus[downloadId];
        
        // Șterge statusurile vechi de peste 1 oră
        if (now - (status.createdAt || now) > 60 * 60 * 1000) {
            delete downloadStatus[downloadId];
        }
    });
}, 30 * 60 * 1000); // La fiecare 30 minute

app.listen(PORT, () => {
    console.log(`🚀 YouTube Downloader cu Cobalt API rulează pe portul ${PORT}`);
    console.log(`🔥 Cobalt API: ${COBALT_API}`);
    console.log(`🌐 https://youtube-downloader-rfbb.onrender.com`);
    console.log(`✅ Gata de descărcare REALĂ cu Cobalt!`);
});
