const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');
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
    return ytdl.validateURL(url);
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

        const options = {
            playerClients: ['WEB_EMBEDDED', 'IOS', 'ANDROID', 'TV'],
            requestOptions: {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
                }
            }
        };
        
        const info = await ytdl.getInfo(url, options);
        const videoDetails = info.videoDetails;
        
        // Obține formatele disponibile
        const formats = ytdl.filterFormats(info.formats, 'videoandaudio');
        const videoOnlyFormats = ytdl.filterFormats(info.formats, 'videoonly');
        
        // Extrage calitățile disponibile
        const qualities = [];
        
        // Adaugă calități pentru video cu audio
        formats.forEach(format => {
            if (format.qualityLabel && !qualities.includes(format.qualityLabel)) {
                qualities.push(format.qualityLabel);
            }
        });
        
        // Adaugă calități video-only de înaltă calitate
        videoOnlyFormats.forEach(format => {
            if (format.qualityLabel && !qualities.includes(format.qualityLabel)) {
                qualities.push(format.qualityLabel);
            }
        });
        
        // Sortează calitățile
        qualities.sort((a, b) => {
            const aNum = parseInt(a);
            const bNum = parseInt(b);
            return bNum - aNum;
        });
        
        res.json({
            success: true,
            info: {
                title: videoDetails.title,
                author: videoDetails.author.name,
                lengthSeconds: parseInt(videoDetails.lengthSeconds),
                viewCount: parseInt(videoDetails.viewCount),
                description: videoDetails.description ? videoDetails.description.substring(0, 200) + '...' : 'Fără descriere',
                thumbnail: videoDetails.thumbnails[videoDetails.thumbnails.length - 1].url,
                qualities: qualities.length > 0 ? qualities : ['720p', '480p', '360p']
            }
        });
    } catch (error) {
        console.error('Eroare la obținerea informațiilor:', error);
        
        // Încearcă cu client diferit dacă primul eșuează
        try {
            console.log('Încerc cu client backup...');
            const backupOptions = {
                playerClients: ['IOS'],
                requestOptions: {
                    headers: {
                        'User-Agent': 'com.google.ios.youtube/19.09.3 (iPhone14,3; U; CPU iOS 15_6 like Mac OS X)',
                        'Accept-Language': 'en-US,en;q=0.9'
                    }
                }
            };
            
            const info = await ytdl.getInfo(url, backupOptions);
            const videoDetails = info.videoDetails;
            
            const formats = ytdl.filterFormats(info.formats, 'videoandaudio');
            const videoOnlyFormats = ytdl.filterFormats(info.formats, 'videoonly');
            
            const qualities = [];
            
            formats.forEach(format => {
                if (format.qualityLabel && !qualities.includes(format.qualityLabel)) {
                    qualities.push(format.qualityLabel);
                }
            });
            
            videoOnlyFormats.forEach(format => {
                if (format.qualityLabel && !qualities.includes(format.qualityLabel)) {
                    qualities.push(format.qualityLabel);
                }
            });
            
            qualities.sort((a, b) => {
                const aNum = parseInt(a);
                const bNum = parseInt(b);
                return bNum - aNum;
            });
            
            res.json({
                success: true,
                info: {
                    title: videoDetails.title,
                    author: videoDetails.author.name,
                    lengthSeconds: parseInt(videoDetails.lengthSeconds),
                    viewCount: parseInt(videoDetails.viewCount),
                    description: videoDetails.description ? videoDetails.description.substring(0, 200) + '...' : 'Fără descriere',
                    thumbnail: videoDetails.thumbnails[videoDetails.thumbnails.length - 1].url,
                    qualities: qualities.length > 0 ? qualities : ['720p', '480p', '360p']
                }
            });
            
        } catch (backupError) {
            console.error('Eroare și la backup:', backupError);
            res.status(500).json({ 
                success: false, 
                error: 'Videoclipul nu poate fi accesat. Poate fi restricționat geografic, privat, sau YouTube blochează cererea.' 
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
        
        const options = {
            playerClients: ['WEB_EMBEDDED', 'IOS', 'ANDROID', 'TV'],
            requestOptions: {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
                }
            }
        };
        
        // Obține informațiile despre video
        const info = await ytdl.getInfo(url, options);
        const videoDetails = info.videoDetails;
        
        const sanitizedTitle = sanitizeFilename(videoDetails.title);
        
        downloadStatus[downloadId].status = 'downloading';
        downloadStatus[downloadId].progress = 25;
        
        let format;
        let filename;
        
        if (quality === 'audio') {
            // Descarcă doar audio
            format = ytdl.chooseFormat(info.formats, { filter: 'audioonly', quality: 'highestaudio' });
            filename = `${sanitizedTitle}_${downloadId}.mp3`;
        } else if (quality === 'best') {
            // Încearcă să găsească cel mai bun format cu video și audio
            format = ytdl.chooseFormat(info.formats, { quality: 'highest' });
            filename = `${sanitizedTitle}_${downloadId}.mp4`;
        } else {
            // Caută calitatea specifică
            const requestedHeight = parseInt(quality);
            format = ytdl.chooseFormat(info.formats, { 
                filter: format => format.height === requestedHeight && format.hasAudio && format.hasVideo 
            });
            
            // Dacă nu găsește cu audio, încearcă fără audio
            if (!format) {
                format = ytdl.chooseFormat(info.formats, { 
                    filter: format => format.height === requestedHeight 
                });
            }
            
            // Fallback la cea mai bună calitate disponibilă
            if (!format) {
                format = ytdl.chooseFormat(info.formats, { quality: 'highest' });
            }
            
            filename = `${sanitizedTitle}_${quality}_${downloadId}.mp4`;
        }
        
        const filePath = path.join(downloadsDir, filename);
        
        return new Promise((resolve, reject) => {
            const stream = ytdl.downloadFromInfo(info, { format: format });
            const writeStream = fs.createWriteStream(filePath);
            
            let downloadedBytes = 0;
            const totalBytes = parseInt(format.contentLength) || 0;
            
            stream.on('progress', (chunkLength, downloaded, total) => {
                downloadedBytes = downloaded;
                if (total > 0) {
                    const progress = Math.min(Math.round((downloaded / total) * 70) + 25, 95);
                    downloadStatus[downloadId].progress = progress;
                }
            });
            
            stream.on('error', (error) => {
                console.error('Eroare la stream:', error);
                downloadStatus[downloadId].status = 'error';
                downloadStatus[downloadId].error = `Eroare la descărcarea videoclipului: ${error.message}`;
                
                // Șterge fișierul parțial
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
                
                reject(error);
            });
            
            writeStream.on('error', (error) => {
                console.error('Eroare la scrierea fișierului:', error);
                downloadStatus[downloadId].status = 'error';
                downloadStatus[downloadId].error = `Eroare la salvarea fișierului: ${error.message}`;
                
                // Șterge fișierul parțial
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
                
                reject(error);
            });
            
            writeStream.on('finish', () => {
                downloadStatus[downloadId].status = 'completed';
                downloadStatus[downloadId].progress = 100;
                downloadStatus[downloadId].filename = filename;
                
                console.log(`✅ Descărcare completă: ${filename}`);
                resolve();
            });
            
            // Pipe stream-ul la fișier
            stream.pipe(writeStream);
        });
        
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
    console.log(`🚀 YouTube Downloader REAL rulează pe portul ${PORT}`);
    console.log(`📁 Fișierele se salvează în: ${path.join(__dirname, 'downloads')}`);
    console.log(`🌐 Server disponibil la: http://localhost:${PORT}`);
});
