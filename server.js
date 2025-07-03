const express = require('express');
const cors = require('cors');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const downloadStatus = {};

// Instalează yt-dlp la startup
function installYtDlp() {
    return new Promise((resolve, reject) => {
        console.log('🔧 Instalez yt-dlp...');
        exec('curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /tmp/yt-dlp && chmod +x /tmp/yt-dlp', (error) => {
            if (error) {
                console.log('⚠️ Nu s-a putut instala yt-dlp, încerc pip...');
                exec('pip3 install yt-dlp', (error2) => {
                    if (error2) {
                        console.log('❌ yt-dlp nu poate fi instalat');
                        reject(error2);
                    } else {
                        console.log('✅ yt-dlp instalat via pip');
                        resolve();
                    }
                });
            } else {
                console.log('✅ yt-dlp instalat manual');
                resolve();
            }
        });
    });
}

function isValidYouTubeUrl(url) {
    const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube|youtu|youtube-nocookie)\.(com|be)\/(watch\?v=|embed\/|v\/|.+\?v=)?([^&=%\?]{11})/;
    return youtubeRegex.test(url);
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

        // Folosește yt-dlp pentru a obține informații
        const ytdlpCmd = fs.existsSync('/tmp/yt-dlp') ? '/tmp/yt-dlp' : 'yt-dlp';
        
        const ytdlp = spawn(ytdlpCmd, [
            '--dump-json',
            '--no-download',
            url
        ]);

        let output = '';
        let errorOutput = '';

        ytdlp.stdout.on('data', (data) => {
            output += data.toString();
        });

        ytdlp.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        ytdlp.on('close', (code) => {
            if (code === 0 && output) {
                try {
                    const videoInfo = JSON.parse(output);
                    
                    // Extrage formatele disponibile
                    const formats = videoInfo.formats || [];
                    const videoFormats = formats.filter(f => f.vcodec && f.vcodec !== 'none' && f.height);
                    const qualities = [...new Set(videoFormats.map(f => f.height + 'p'))].sort((a, b) => parseInt(b) - parseInt(a));
                    
                    res.json({
                        success: true,
                        info: {
                            title: videoInfo.title || 'Titlu necunoscut',
                            author: videoInfo.uploader || videoInfo.channel || 'Canal necunoscut',
                            lengthSeconds: videoInfo.duration || 0,
                            viewCount: videoInfo.view_count || 0,
                            description: videoInfo.description ? videoInfo.description.substring(0, 200) + '...' : 'Fără descriere',
                            thumbnail: videoInfo.thumbnail || null,
                            qualities: qualities.length > 0 ? qualities : ['720p', '480p', '360p']
                        }
                    });
                } catch (parseError) {
                    console.error('Eroare la parsarea JSON:', parseError);
                    res.status(500).json({ 
                        success: false, 
                        error: 'Eroare la procesarea informațiilor video' 
                    });
                }
            } else {
                console.error('Eroare yt-dlp:', errorOutput);
                res.status(500).json({ 
                    success: false, 
                    error: 'Nu s-au putut obține informațiile video. Videoclipul poate fi restricționat.' 
                });
            }
        });

    } catch (error) {
        console.error('Eroare la obținerea informațiilor:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Eroare internă la obținerea informațiilor' 
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
            // Șterge fișierul după 10 minute
            setTimeout(() => {
                try {
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                    }
                    delete downloadStatus[downloadId];
                } catch (e) {
                    console.error('Eroare la ștergerea fișierului:', e);
                }
            }, 10 * 60 * 1000);
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
        
        downloadStatus[downloadId].status = 'downloading';
        downloadStatus[downloadId].progress = 10;
        
        const ytdlpCmd = fs.existsSync('/tmp/yt-dlp') ? '/tmp/yt-dlp' : 'yt-dlp';
        
        // Configurează argumentele pentru yt-dlp
        let args = [];
        let fileExtension = '';
        
        if (quality === 'audio') {
            args = [
                '--extract-audio',
                '--audio-format', 'mp3',
                '--audio-quality', '320K',
                '--output', path.join(downloadsDir, `%(title)s_${downloadId}.%(ext)s`),
                url
            ];
            fileExtension = 'mp3';
        } else if (quality === 'best') {
            args = [
                '--format', 'best[ext=mp4]/best',
                '--output', path.join(downloadsDir, `%(title)s_${downloadId}.%(ext)s`),
                url
            ];
            fileExtension = 'mp4';
        } else {
            // Calitate specifică (720p, 1080p, etc.)
            const height = quality.replace('p', '');
            args = [
                '--format', `best[height<=${height}][ext=mp4]/best[height<=${height}]`,
                '--output', path.join(downloadsDir, `%(title)s_${downloadId}.%(ext)s`),
                url
            ];
            fileExtension = 'mp4';
        }
        
        console.log(`🎬 Începe descărcarea cu yt-dlp: ${url}`);
        
        const ytdlp = spawn(ytdlpCmd, args);
        
        let filename = null;
        
        ytdlp.stdout.on('data', (data) => {
            const output = data.toString();
            console.log('yt-dlp output:', output);
            
            // Caută progresul în output
            const progressMatch = output.match(/(\d+\.?\d*)%/);
            if (progressMatch) {
                const progress = Math.min(parseFloat(progressMatch[1]), 95);
                downloadStatus[downloadId].progress = progress;
            }
        });

        ytdlp.stderr.on('data', (data) => {
            const error = data.toString();
            console.log('yt-dlp stderr:', error);
            
            // Caută și progresul în stderr (yt-dlp afișează acolo)
            const progressMatch = error.match(/(\d+\.?\d*)%/);
            if (progressMatch) {
                const progress = Math.min(parseFloat(progressMatch[1]), 95);
                downloadStatus[downloadId].progress = progress;
            }
        });

        ytdlp.on('close', (code) => {
            if (code === 0) {
                // Găsește fișierul descărcat
                try {
                    const files = fs.readdirSync(downloadsDir);
                    const downloadedFile = files.find(file => file.includes(downloadId));
                    
                    if (downloadedFile) {
                        downloadStatus[downloadId].status = 'completed';
                        downloadStatus[downloadId].progress = 100;
                        downloadStatus[downloadId].filename = downloadedFile;
                        console.log(`✅ Descărcare completă: ${downloadedFile}`);
                    } else {
                        throw new Error('Fișierul descărcat nu a fost găsit');
                    }
                } catch (error) {
                    downloadStatus[downloadId].status = 'error';
                    downloadStatus[downloadId].error = 'Fișierul nu a fost salvat corect';
                }
            } else {
                downloadStatus[downloadId].status = 'error';
                downloadStatus[downloadId].error = 'Eroare la descărcarea videoclipului';
                console.error(`❌ yt-dlp a eșuat cu codul: ${code}`);
            }
        });

    } catch (error) {
        console.error('Eroare la procesarea descărcării:', error);
        downloadStatus[downloadId].status = 'error';
        downloadStatus[downloadId].error = `Eroare: ${error.message}`;
    }
}

// Cleanup periodic
setInterval(() => {
    const downloadsDir = path.join(__dirname, 'downloads');
    if (!fs.existsSync(downloadsDir)) return;
    
    try {
        const files = fs.readdirSync(downloadsDir);
        const now = Date.now();
        
        files.forEach(file => {
            const filePath = path.join(downloadsDir, file);
            try {
                const stats = fs.statSync(filePath);
                const fileAge = now - stats.mtime.getTime();
                
                if (fileAge > 60 * 60 * 1000) { // 1 oră
                    fs.unlinkSync(filePath);
                    console.log(`🗑️ Șters: ${file}`);
                }
            } catch (e) {
                console.error(`Eroare la ștergere: ${e}`);
            }
        });
    } catch (error) {
        console.error('Eroare cleanup:', error);
    }
}, 30 * 60 * 1000); // 30 minute

// Instalează yt-dlp la startup și pornește serverul
installYtDlp().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 YouTube Downloader REAL rulează pe portul ${PORT}`);
        console.log(`✅ yt-dlp instalat și gata de descărcare!`);
        console.log(`🌐 https://youtube-downloader-rfbb.onrender.com`);
    });
}).catch(error => {
    console.error('❌ Nu s-a putut instala yt-dlp:', error);
    
    // Pornește oricum serverul, dar cu funcționalitate limitată
    app.listen(PORT, () => {
        console.log(`⚠️ Server pornit fără yt-dlp - funcționalitate limitată`);
    });
});
