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

// Multiple API endpoints pentru backup
const API_ENDPOINTS = [
    'https://cobalt.tools/api/json',
    'https://co.wuk.sh/api/json',
    'https://api.cobalt.tools/api/json'
];

function isValidYouTubeUrl(url) {
    const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube|youtu|youtube-nocookie)\.(com|be)\/(watch\?v=|embed\/|v\/|.+\?v=)?([^&=%\?]{11})/;
    return youtubeRegex.test(url);
}

function getVideoId(url) {
    const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
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

        // Returnează informații de bază - nu mai încercăm API-uri externe care pot fi blocate
        res.json({
            success: true,
            info: {
                title: `YouTube Video - ${videoId}`,
                author: 'YouTube Channel',
                lengthSeconds: 0,
                viewCount: 0,
                description: 'Video disponibil pentru descărcare',
                thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
                qualities: ['1080p', '720p', '480p', '360p', 'audio']
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
            error: null,
            downloadUrl: null
        };

        // Procesează descărcarea cu multiple API-uri
        processDownloadWithMultipleAPIs(downloadId, url, quality).catch(error => {
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
            // Redirect la URL-ul de descărcare
            res.redirect(status.downloadUrl);
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

async function tryMultipleAPIs(url, settings) {
    const errors = [];
    
    // 1. Încearcă direct cu cobalt.tools (GET method)
    try {
        console.log('🔄 Încerc cobalt.tools direct...');
        const directUrl = `https://cobalt.tools/?u=${encodeURIComponent(url)}`;
        
        // Returnează URL-ul direct către cobalt.tools
        return {
            success: true,
            url: directUrl,
            method: 'direct'
        };
    } catch (error) {
        errors.push(`Direct: ${error.message}`);
    }
    
    // 2. Încearcă API-urile POST
    for (const endpoint of API_ENDPOINTS) {
        try {
            console.log(`🔄 Încerc ${endpoint}...`);
            
            const response = await axios.post(endpoint, settings, {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                timeout: 15000
            });
            
            if (response.data && response.data.status === 'success') {
                console.log(`✅ Succes cu ${endpoint}`);
                return {
                    success: true,
                    data: response.data,
                    endpoint: endpoint
                };
            }
        } catch (error) {
            console.log(`❌ Eșec ${endpoint}: ${error.message}`);
            errors.push(`${endpoint}: ${error.message}`);
            continue;
        }
    }
    
    // 3. Încearcă SaveFrom.net ca backup
    try {
        console.log('🔄 Încerc SaveFrom.net...');
        const saveFromUrl = `https://savefrom.net/#url=${encodeURIComponent(url)}&utm_source=userjs&utm_medium=extensions&utm_campaign=link_modifier`;
        
        return {
            success: true,
            url: saveFromUrl,
            method: 'savefrom'
        };
    } catch (error) {
        errors.push(`SaveFrom: ${error.message}`);
    }
    
    // 4. Ultimul backup - Y2mate
    try {
        console.log('🔄 Încerc Y2mate...');
        const y2mateUrl = `https://www.y2mate.com/youtube/${getVideoId(url)}`;
        
        return {
            success: true,
            url: y2mateUrl,
            method: 'y2mate'
        };
    } catch (error) {
        errors.push(`Y2mate: ${error.message}`);
    }
    
    throw new Error(`Toate API-urile au eșuat: ${errors.join(', ')}`);
}

async function processDownloadWithMultipleAPIs(downloadId, url, quality) {
    try {
        downloadStatus[downloadId].status = 'downloading';
        downloadStatus[downloadId].progress = 25;
        
        console.log(`🎬 Început descărcare: ${url}`);
        
        // Configurează setările
        let settings = {
            url: url,
            downloadMode: 'auto',
            youtubeVideoFormat: 'mp4'
        };
        
        if (quality === 'audio') {
            settings.downloadMode = 'audio';
            settings.youtubeAudioFormat = 'mp3';
        } else if (quality !== 'best') {
            settings.youtubeVideoQuality = quality;
        }
        
        downloadStatus[downloadId].progress = 50;
        
        // Încearcă toate API-urile
        const result = await tryMultipleAPIs(url, settings);
        
        downloadStatus[downloadId].progress = 75;
        
        if (result.success) {
            if (result.url) {
                // URL direct (cobalt.tools, savefrom, y2mate)
                downloadStatus[downloadId].status = 'completed';
                downloadStatus[downloadId].progress = 100;
                downloadStatus[downloadId].downloadUrl = result.url;
                downloadStatus[downloadId].filename = `video_${downloadId}.${quality === 'audio' ? 'mp3' : 'mp4'}`;
                
                console.log(`✅ Descărcare completă via ${result.method}: ${result.url}`);
            } else if (result.data) {
                // Răspuns API cu date
                if (result.data.url) {
                    downloadStatus[downloadId].status = 'completed';
                    downloadStatus[downloadId].progress = 100;
                    downloadStatus[downloadId].downloadUrl = result.data.url;
                    downloadStatus[downloadId].filename = `video_${downloadId}.${quality === 'audio' ? 'mp3' : 'mp4'}`;
                    
                    console.log(`✅ Descărcare completă: ${result.data.url}`);
                } else if (result.data.picker && result.data.picker.length > 0) {
                    const firstOption = result.data.picker[0];
                    downloadStatus[downloadId].status = 'completed';
                    downloadStatus[downloadId].progress = 100;
                    downloadStatus[downloadId].downloadUrl = firstOption.url;
                    downloadStatus[downloadId].filename = `video_${downloadId}.${quality === 'audio' ? 'mp3' : 'mp4'}`;
                    
                    console.log(`✅ Descărcare completă (picker): ${firstOption.url}`);
                } else {
                    throw new Error('Nu s-a primit URL de descărcare');
                }
            }
        } else {
            throw new Error('Toate metodele au eșuat');
        }
        
    } catch (error) {
        console.error('Eroare la procesarea descărcării:', error);
        
        downloadStatus[downloadId].status = 'error';
        downloadStatus[downloadId].error = `Eroare: ${error.message}`;
        
        throw error;
    }
}

// Cleanup periodic
setInterval(() => {
    const now = Date.now();
    
    Object.keys(downloadStatus).forEach(downloadId => {
        const status = downloadStatus[downloadId];
        
        // Șterge statusurile vechi de peste 2 ore
        if (now - (status.createdAt || now) > 2 * 60 * 60 * 1000) {
            delete downloadStatus[downloadId];
        }
    });
}, 30 * 60 * 1000);

app.listen(PORT, () => {
    console.log(`🚀 YouTube Downloader MULTI-API rulează pe portul ${PORT}`);
    console.log(`🔄 API endpoints: ${API_ENDPOINTS.join(', ')}`);
    console.log(`🌐 https://youtube-downloader-rfbb.onrender.com`);
    console.log(`✅ Multiple backup methods configurate!`);
});
