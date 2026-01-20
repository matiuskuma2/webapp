import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'
import type { Bindings } from './types/bindings'
import projects from './routes/projects'
import transcriptions from './routes/transcriptions'
import parsing from './routes/parsing'
import formatting from './routes/formatting'
import imageGeneration from './routes/image-generation'
import downloads from './routes/downloads'
import scenes from './routes/scenes'
import images from './routes/images'
import debug from './routes/debug'
import runs from './routes/runs'
import runsV2 from './routes/runs-v2'
import styles from './routes/styles'
import audioGeneration from './routes/audio-generation'
import audio from './routes/audio'
import worldSettings from './routes/world-settings' // Phase X-2
import characterModels from './routes/character-models' // Phase X-2
import sceneCharacters from './routes/scene-characters' // Phase X-2
import videoGeneration from './routes/video-generation' // Video I2V
import settings from './routes/settings' // User settings & API keys
import auth from './routes/auth' // Authentication
import admin from './routes/admin' // Admin API routes
import comic from './routes/comic' // Phase1.5: Comic editor API
import { adminHtml } from './pages/admin' // Admin page HTML
import { settingsHtml } from './pages/settings' // Settings page HTML

const app = new Hono<{ Bindings: Bindings }>()

// Enable CORS for API routes
app.use('/api/*', cors())

// Enable foreign_keys for SQLite/D1 (堅牢化のため)
app.use('/api/*', async (c, next) => {
  try {
    if (c.env?.DB) {
      await c.env.DB.prepare('PRAGMA foreign_keys = ON').run()
    }
  } catch (error) {
    console.warn('PRAGMA foreign_keys = ON failed:', error)
  }
  await next()
})

// Serve static files
app.use('/static/*', serveStatic({ root: './public' }))

// API routes
app.route('/api/projects', projects)
app.route('/api/projects', transcriptions)
app.route('/api/projects', parsing) // For /api/projects/:id/parse
app.route('/api/projects', formatting)
app.route('/api/projects', imageGeneration)
app.route('/api/projects', downloads) // For download endpoints
app.route('/api/projects', scenes) // For /api/projects/:id/scenes/reorder
app.route('/api', audioGeneration) // For /api/scenes/:id/audio, /api/audio/:audioId/activate (Phase 2-A) - MUST be before generic /api/scenes/:id
app.route('/api/scenes', sceneCharacters) // For /api/scenes/:sceneId/characters - MUST be before generic /api/scenes/:id
app.route('/api/scenes', videoGeneration) // For /api/scenes/:sceneId/videos - MUST be before generic /api/scenes/:id
app.route('/api/scenes', comic) // For /api/scenes/:id/comic/* - Phase1.5 comic editor
app.route('/api/scenes', scenes) // For /api/scenes/:id (PUT/DELETE)
app.route('/api/scenes', images) // For /api/scenes/:id/images
app.route('/api/images', images) // For /api/images/:id/activate
app.route('/api', imageGeneration) // For /api/scenes/:id/generate-image
app.route('/api/debug', debug) // For /api/debug/env (temporary)
app.route('/images', images) // For direct R2 image access
app.route('/audio', audio) // For direct R2 audio access (Phase 3)

// Style presets routes
app.route('/api', styles) // For /api/style-presets, /api/projects/:id/style-settings, /api/scenes/:id/style

// Run management routes (Phase B-0 & B-1)
app.route('/api', runs) // For /api/projects/:projectId/runs, /api/runs/:runId

// Run v2 API routes (Phase B-2)
app.route('/api/runs', runsV2) // For /api/runs/:runId/parse, format, generate-images, scenes

// Phase X-2: World & Character Bible routes
app.route('/api', worldSettings) // For /api/projects/:projectId/world-settings
app.route('/api', characterModels) // For /api/projects/:projectId/characters
// sceneCharacters moved above scenes route for proper matching

// Video I2V routes
app.route('/api', videoGeneration) // For /api/scenes/:sceneId/generate-video, /api/videos/:videoId/*

// Settings routes (API key management)
app.route('/api', settings) // For /api/settings/api-keys/*

// Authentication routes
app.route('/api', auth) // For /api/auth/*
app.route('/api/admin', admin) // For /api/admin/* (superadmin only)

// Root route - serve HTML
// Root route - with authentication check
app.get('/', (c) => {
  return c.html(`
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <title>RILARC Scenario Generator</title>
    <link rel="icon" type="image/svg+xml" href="/static/favicon.svg">
    <link href="/static/styles.css" rel="stylesheet">
    <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
    <style>
        /* Mobile-First Optimizations */
        * {
            -webkit-tap-highlight-color: rgba(0, 0, 0, 0);
        }
        
        body {
            overscroll-behavior: none;
            touch-action: pan-y;
        }
        
        .touch-manipulation {
            touch-action: manipulation;
        }
        
        /* Large touch targets for mobile */
        @media (max-width: 768px) {
            button, a, input[type="file"] {
                min-height: 48px;
                font-size: 16px;
            }
            
            .container {
                padding-left: 1rem;
                padding-right: 1rem;
            }
            
            /* Prevent zoom on input focus */
            input, select, textarea {
                font-size: 16px;
            }
        }
        
        /* Recording animation */
        @keyframes pulse {
            0%, 100% {
                opacity: 1;
            }
            50% {
                opacity: 0.5;
            }
        }
        
        .animate-pulse {
            animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
        }
        
        /* User dropdown menu */
        .user-dropdown {
            position: relative;
        }
        .user-dropdown-menu {
            position: absolute;
            right: 0;
            top: 100%;
            margin-top: 0.5rem;
            background: white;
            border-radius: 0.5rem;
            box-shadow: 0 10px 25px rgba(0,0,0,0.15);
            min-width: 200px;
            z-index: 100;
            display: none;
        }
        .user-dropdown-menu.show {
            display: block;
        }
        .user-dropdown-menu a, .user-dropdown-menu button {
            display: block;
            width: 100%;
            padding: 0.75rem 1rem;
            text-align: left;
            color: #374151;
            transition: background-color 0.2s;
        }
        .user-dropdown-menu a:hover, .user-dropdown-menu button:hover {
            background-color: #f3f4f6;
        }
    </style>
</head>
<body class="bg-gray-100 min-h-screen">
    <!-- Loading / Auth Check -->
    <div id="authLoading" class="flex items-center justify-center min-h-screen">
        <div class="text-center">
            <i class="fas fa-spinner fa-spin text-4xl text-blue-600 mb-4"></i>
            <p class="text-gray-600">認証を確認中...</p>
        </div>
    </div>

    <!-- Main Content (hidden until authenticated) -->
    <div id="mainContent" class="hidden">
        <!-- Header with User Info (Phase C-2-2) -->
        <header class="bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-lg">
            <div class="container mx-auto px-4 py-4 flex items-center justify-between">
                <h1 class="text-xl font-bold">
                    <i class="fas fa-video mr-2"></i>
                    RILARC Scenario Generator
                </h1>
                <div class="flex items-center gap-4">
                    <!-- Admin Link (superadmin only) -->
                    <a id="adminLink" href="/admin" class="hidden text-white/80 hover:text-white transition-colors">
                        <i class="fas fa-cog mr-1"></i>
                        <span class="hidden sm:inline">管理画面</span>
                    </a>
                    
                    <!-- User Dropdown -->
                    <div class="user-dropdown">
                        <button id="userDropdownBtn" class="flex items-center gap-2 px-3 py-2 bg-white/10 rounded-lg hover:bg-white/20 transition-colors">
                            <i class="fas fa-user-circle text-xl"></i>
                            <span id="userName" class="hidden sm:inline">ユーザー</span>
                            <i class="fas fa-chevron-down text-xs"></i>
                        </button>
                        <div id="userDropdownMenu" class="user-dropdown-menu">
                            <div class="px-4 py-3 border-b">
                                <p id="userEmail" class="text-sm text-gray-500">email@example.com</p>
                                <p id="userRole" class="text-xs text-blue-600 mt-1">管理者</p>
                            </div>
                            <a href="/settings">
                                <i class="fas fa-cog mr-2 text-gray-400"></i>設定
                            </a>
                            <button id="logoutBtn" class="text-red-600 hover:bg-red-50">
                                <i class="fas fa-sign-out-alt mr-2"></i>ログアウト
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </header>
        
        <div class="container mx-auto px-4 py-8">
            <!-- Phase 1: プロジェクト作成 -->
            <div class="bg-white rounded-lg shadow-md p-6 mb-6">
                <h2 class="text-xl font-semibold text-gray-700 mb-4">
                    <i class="fas fa-folder-plus mr-2 text-blue-600"></i>
                    新規プロジェクト作成
                </h2>
                <div class="flex flex-col sm:flex-row gap-4">
                    <div class="flex flex-1 gap-2">
                        <input 
                            type="text" 
                            id="projectTitle" 
                            placeholder="プロジェクトタイトルを入力"
                            class="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                        <button 
                            id="createProjectBtn"
                            onclick="createProject()"
                            class="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors whitespace-nowrap"
                        >
                            <i class="fas fa-plus mr-2"></i>作成
                        </button>
                    </div>
                    <button 
                        onclick="openTemplateModal()"
                        class="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors whitespace-nowrap"
                    >
                        <i class="fas fa-copy mr-2"></i>テンプレから作成
                    </button>
                </div>
            </div>

            <!-- プロジェクト一覧 -->
            <div class="bg-white rounded-lg shadow-md p-6">
                <h2 class="text-xl font-semibold text-gray-700 mb-4">
                    <i class="fas fa-list mr-2 text-blue-600"></i>
                    プロジェクト一覧
                </h2>
                <div id="projectsList" class="space-y-3">
                    <p class="text-gray-500 text-center py-8">読み込み中...</p>
                </div>
            </div>
        </div>
    </div>

    <!-- Toast通知 -->
    <div id="toast" class="fixed top-4 right-4 hidden z-50">
        <div class="bg-white border-l-4 rounded-lg shadow-lg p-4 max-w-sm">
            <div class="flex items-center">
                <i id="toastIcon" class="fas fa-check-circle text-2xl mr-3"></i>
                <p id="toastMessage" class="text-gray-800"></p>
            </div>
        </div>
    </div>

    <!-- テンプレート選択モーダル -->
    <div id="templateModal" class="fixed inset-0 bg-black bg-opacity-50 hidden z-40 flex items-center justify-center">
        <div class="bg-white rounded-lg shadow-xl max-w-lg w-full mx-4 max-h-[80vh] overflow-hidden flex flex-col">
            <div class="p-6 border-b">
                <div class="flex justify-between items-center">
                    <h2 class="text-xl font-bold text-gray-800">
                        <i class="fas fa-copy mr-2 text-green-600"></i>
                        テンプレートから作成
                    </h2>
                    <button onclick="closeTemplateModal()" class="text-gray-500 hover:text-gray-700">
                        <i class="fas fa-times text-xl"></i>
                    </button>
                </div>
            </div>
            <div class="p-6 overflow-y-auto flex-1">
                <div class="mb-4">
                    <label class="block text-sm font-medium text-gray-700 mb-2">新規プロジェクト名</label>
                    <input 
                        type="text" 
                        id="templateProjectTitle" 
                        placeholder="（空欄の場合はテンプレ名 + コピー）"
                        class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
                    />
                </div>
                <div class="mb-2">
                    <label class="block text-sm font-medium text-gray-700 mb-2">テンプレートを選択</label>
                </div>
                <div id="templateList" class="space-y-2">
                    <p class="text-gray-500 text-center py-4">読み込み中...</p>
                </div>
            </div>
            <div class="p-4 border-t bg-gray-50 text-sm text-gray-500">
                <i class="fas fa-info-circle mr-1"></i>
                テンプレートを選択すると、シーン構成・キャラクター設定がコピーされます
            </div>
        </div>
    </div>

    <!-- プロジェクト詳細モーダル -->
    <div id="projectModal" class="fixed inset-0 bg-black bg-opacity-50 hidden z-40 flex items-center justify-center">
        <div class="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-screen overflow-y-auto">
            <div class="p-6">
                <div class="flex justify-between items-center mb-4">
                    <h2 class="text-2xl font-bold text-gray-800">プロジェクト詳細</h2>
                    <button onclick="closeModal()" class="text-gray-500 hover:text-gray-700">
                        <i class="fas fa-times text-2xl"></i>
                    </button>
                </div>
                <div id="modalContent"></div>
            </div>
        </div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
    <script>
        // Phase C-1-1: Authentication check on page load
        window.currentUser = null;
        
        async function checkAuth() {
            try {
                const res = await axios.get('/api/auth/me');
                if (!res.data.authenticated) {
                    window.location.href = '/login';
                    return;
                }
                
                window.currentUser = res.data.user;
                
                // Update UI with user info
                document.getElementById('userName').textContent = res.data.user.name;
                document.getElementById('userEmail').textContent = res.data.user.email;
                document.getElementById('userRole').textContent = 
                    res.data.user.role === 'superadmin' ? 'スーパー管理者' : '管理者';
                
                // Show admin link for superadmin
                if (res.data.user.role === 'superadmin') {
                    document.getElementById('adminLink').classList.remove('hidden');
                }
                
                // Hide loading, show content
                document.getElementById('authLoading').classList.add('hidden');
                document.getElementById('mainContent').classList.remove('hidden');
                
                // Load projects
                if (typeof loadProjects === 'function') {
                    loadProjects();
                }
            } catch (err) {
                console.error('Auth check failed:', err);
                window.location.href = '/login';
            }
        }
        
        // User dropdown toggle
        document.getElementById('userDropdownBtn').addEventListener('click', (e) => {
            e.stopPropagation();
            document.getElementById('userDropdownMenu').classList.toggle('show');
        });
        
        // Close dropdown when clicking outside
        document.addEventListener('click', () => {
            document.getElementById('userDropdownMenu').classList.remove('show');
        });
        
        // Logout
        document.getElementById('logoutBtn').addEventListener('click', async () => {
            try {
                await axios.post('/api/auth/logout');
                window.location.href = '/login';
            } catch (err) {
                console.error('Logout failed:', err);
                window.location.href = '/login';
            }
        });
        
        // Check auth on page load
        checkAuth();
    </script>
    <script src="/static/app.js"></script>
</body>
</html>
  `)
})

// Project Editor route

app.get('/projects/:id', (c) => {
  const projectId = c.req.param('id')
  
  return c.html(`

<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <title>Project Editor - RILARC</title>
    <link rel="icon" type="image/svg+xml" href="/static/favicon.svg">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;700&family=Noto+Serif+JP:wght@400;700&family=M+PLUS+Rounded+1c:wght@400;700&family=Yomogi&display=swap" rel="stylesheet">
    <link href="/static/styles.css" rel="stylesheet">
    <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
    <style>
        /* Mobile-First Optimizations */
        * {
            -webkit-tap-highlight-color: rgba(0, 0, 0, 0);
        }
        
        body {
            overscroll-behavior: none;
            touch-action: pan-y;
        }
        
        .touch-manipulation {
            touch-action: manipulation;
        }
        
        /* Large touch targets for mobile */
        @media (max-width: 768px) {
            button, a, input[type="file"] {
                min-height: 48px;
                font-size: 16px;
            }
            
            .container {
                padding-left: 1rem;
                padding-right: 1rem;
            }
            
            /* Prevent zoom on input focus */
            input, select, textarea {
                font-size: 16px;
            }
        }
        
        /* Recording animation */
        @keyframes pulse {
            0%, 100% {
                opacity: 1;
            }
            50% {
                opacity: 0.5;
            }
        }
        
        .animate-pulse {
            animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
        }
        
        /* Tab styles */
        .tab-active {
            border-bottom: 3px solid #2563eb;
            color: #2563eb;
        }
        
        .tab-inactive {
            color: #6b7280;
        }
        
        /* Filter button styles */
        .filter-btn {
            padding: 0.5rem 1rem;
            border-radius: 0.5rem;
            font-size: 0.875rem;
            font-weight: 600;
            transition: all 0.2s;
            border: 2px solid #e5e7eb;
            background-color: white;
            color: #6b7280;
        }
        
        .filter-btn:hover {
            border-color: #3b82f6;
            background-color: #eff6ff;
        }
        
        .filter-btn.active {
            border-color: #3b82f6;
            background-color: #3b82f6;
            color: white;
        }
    </style>
</head>
<body class="bg-gray-100 min-h-screen">
    <div class="container mx-auto px-4 py-8">
        <!-- Header -->
        <div class="bg-white rounded-lg shadow-md p-6 mb-6">
            <div class="flex items-center justify-between mb-4">
                <div class="flex items-center gap-4">
                    <a href="/" class="text-gray-600 hover:text-gray-800">
                        <i class="fas fa-arrow-left text-xl"></i>
                    </a>
                    <div>
                        <h1 id="projectTitle" class="text-2xl font-bold text-gray-800">読み込み中...</h1>
                        <span id="projectStatus" class="inline-block mt-2 px-3 py-1 rounded-full text-sm font-semibold">
                            <i class="fas fa-circle mr-1"></i>
                            <span id="statusText">-</span>
                        </span>
                    </div>
                </div>
                <div class="flex gap-2">
                    <button 
                        id="deleteBtn"
                        onclick="confirmDeleteProject()"
                        class="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors touch-manipulation"
                    >
                        <i class="fas fa-trash mr-1"></i>削除
                    </button>
                </div>
            </div>
        </div>

        <!-- Tabs -->
        <div class="bg-white rounded-lg shadow-md mb-6 overflow-x-auto">
            <div class="flex border-b">
                <button 
                    class="px-6 py-4 font-semibold transition-colors tab-active touch-manipulation"
                    id="tabInput"
                    onclick="switchTab('input')"
                >
                    <i class="fas fa-upload mr-2"></i>Input
                </button>
                <button 
                    class="px-6 py-4 font-semibold transition-colors tab-inactive touch-manipulation"
                    id="tabSceneSplit"
                    onclick="switchTab('sceneSplit')"
                    disabled
                >
                    <i class="fas fa-cut mr-2"></i>Scene Split
                </button>
                <button 
                    class="px-6 py-4 font-semibold transition-colors tab-inactive touch-manipulation"
                    id="tabBuilder"
                    onclick="switchTab('builder')"
                    disabled
                >
                    <i class="fas fa-image mr-2"></i>Builder
                </button>
                <button 
                    class="px-6 py-4 font-semibold transition-colors tab-inactive touch-manipulation"
                    id="tabExport"
                    onclick="switchTab('export')"
                    disabled
                >
                    <i class="fas fa-download mr-2"></i>Export
                </button>
                <button 
                    class="px-6 py-4 font-semibold transition-colors tab-inactive touch-manipulation"
                    id="tabVideoBuild"
                    onclick="switchTab('videoBuild')"
                    disabled
                >
                    <i class="fas fa-film mr-2"></i>Video Build
                </button>
                <button 
                    class="px-6 py-4 font-semibold transition-colors tab-inactive touch-manipulation"
                    id="tabStyles"
                    onclick="switchTab('styles')"
                >
                    <i class="fas fa-palette mr-2"></i>Styles
                </button>
            </div>
        </div>

        <!-- Tab Contents -->
        <div class="bg-white rounded-lg shadow-md p-6">
            <!-- Input Tab -->
            <div id="contentInput">
                <h2 class="text-xl font-bold text-gray-800 mb-6">
                    <i class="fas fa-upload mr-2 text-blue-600"></i>
                    音声またはテキストを入力
                </h2>
                
                <!-- 3 Input Methods -->
                <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <!-- A) Microphone Recording -->
                    <div class="p-6 bg-blue-50 rounded-lg border-2 border-blue-200">
                        <h3 class="font-semibold text-gray-800 mb-4 flex items-center">
                            <i class="fas fa-microphone-alt mr-2 text-blue-600"></i>
                            マイク録音
                            <span class="ml-2 text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">スマホ推奨</span>
                        </h3>
                        <div id="recordingStatus" class="mb-4 text-sm text-gray-600 hidden">
                            <div class="flex items-center justify-center mb-2">
                                <div class="w-4 h-4 bg-red-500 rounded-full animate-pulse mr-2"></div>
                                <span class="font-semibold">録音中...</span>
                                <span id="recordingTime" class="ml-2">0:00</span>
                            </div>
                            <div class="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                                <div id="recordingProgress" class="bg-blue-600 h-full transition-all duration-300" style="width: 0%"></div>
                            </div>
                        </div>
                        <div class="flex flex-col gap-2">
                            <button 
                                id="startRecordBtn"
                                onclick="startRecording()"
                                class="w-full px-6 py-3 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors font-semibold touch-manipulation"
                            >
                                <i class="fas fa-microphone mr-2"></i>録音開始
                            </button>
                            <button 
                                id="stopRecordBtn"
                                onclick="stopRecording()"
                                class="w-full px-6 py-3 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors font-semibold hidden touch-manipulation"
                            >
                                <i class="fas fa-stop mr-2"></i>録音停止
                            </button>
                        </div>
                        <p class="text-xs text-gray-500 mt-3">
                            <i class="fas fa-info-circle mr-1"></i>
                            ブラウザでマイク許可が必要です
                        </p>
                    </div>
                    
                    <!-- B) File Upload -->
                    <div class="p-6 bg-gray-50 rounded-lg border-2 border-gray-200">
                        <h3 class="font-semibold text-gray-800 mb-4 flex items-center">
                            <i class="fas fa-upload mr-2 text-gray-600"></i>
                            ファイルアップロード
                            <span class="ml-2 text-xs bg-gray-100 text-gray-800 px-2 py-1 rounded">PC推奨</span>
                        </h3>
                        <input 
                            type="file" 
                            id="audioFile" 
                            accept="audio/*,audio/webm,audio/mp3,audio/wav,audio/m4a,audio/ogg" 
                            class="block w-full text-sm text-gray-600 mb-4
                            file:mr-4 file:py-3 file:px-6 file:rounded-lg file:border-0
                            file:font-semibold file:bg-blue-600 file:text-white
                            hover:file:bg-blue-700 cursor-pointer touch-manipulation"
                        />
                        <button 
                            id="uploadAudioBtn"
                            onclick="uploadAudio()"
                            class="w-full px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-semibold touch-manipulation"
                        >
                            <i class="fas fa-upload mr-2"></i>アップロード
                        </button>
                        <p class="text-xs text-gray-500 mt-3">
                            <i class="fas fa-info-circle mr-1"></i>
                            対応形式: MP3, WAV, M4A, OGG, WebM
                        </p>
                    </div>
                    
                    <!-- C) Text Paste -->
                    <div class="p-6 bg-green-50 rounded-lg border-2 border-green-200">
                        <h3 class="font-semibold text-gray-800 mb-4 flex items-center">
                            <i class="fas fa-keyboard mr-2 text-green-600"></i>
                            テキスト貼り付け
                            <span class="ml-2 text-xs bg-green-100 text-green-800 px-2 py-1 rounded">音声不要</span>
                        </h3>
                        <textarea 
                            id="sourceText"
                            placeholder="シナリオテキストを貼り付けてください..."
                            rows="6"
                            class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 text-sm"
                        ></textarea>
                        <div class="text-xs text-gray-500 mb-3">
                            <span id="textCharCount">0</span> 文字
                        </div>
                        <button 
                            id="saveTextBtn"
                            onclick="saveSourceText()"
                            class="w-full px-6 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-semibold touch-manipulation"
                        >
                            <i class="fas fa-save mr-2"></i>保存
                        </button>
                        <p class="text-xs text-gray-500 mt-3">
                            <i class="fas fa-info-circle mr-1"></i>
                            保存後、Scene Splitへ進めます
                        </p>
                    </div>
                </div>
                
                <!-- Character Speaker Guidelines -->
                <div class="mt-6 p-6 bg-amber-50 border-2 border-amber-300 rounded-lg">
                    <h3 class="font-semibold text-gray-800 mb-3 flex items-center">
                        <i class="fas fa-user-tag mr-2 text-amber-600"></i>
                        📝 キャラクター情報の記載について（重要）
                    </h3>
                    <div class="space-y-3 text-sm text-gray-700">
                        <p class="leading-relaxed">
                            <strong class="text-amber-700">シナリオにキャラクター名（話者情報）を含めると、自動的にキャラクターが割り当てられます。</strong>
                        </p>
                        <div class="bg-white p-4 rounded border border-amber-200">
                            <p class="font-semibold text-gray-800 mb-2">【推奨フォーマット】</p>
                            <pre class="text-xs text-gray-700 font-mono bg-gray-50 p-2 rounded">太郎: 「おはよう、花子！」
花子: 「おはよう、太郎！」
ナレーター: 二人は笑顔で挨拶を交わした。</pre>
                        </div>
                        <div class="space-y-1">
                            <p><i class="fas fa-check-circle text-green-600 mr-1"></i> キャラクター名は事前に <strong>Styles &gt; Characters</strong> で登録してください</p>
                            <p><i class="fas fa-info-circle text-blue-600 mr-1"></i> 話者情報がない場合、AIが推測しますが精度が下がります</p>
                            <p><i class="fas fa-edit text-purple-600 mr-1"></i> 後から <strong>Builder</strong> タブで手動修正も可能です</p>
                        </div>
                        <p class="text-xs text-amber-700 mt-3">
                            <i class="fas fa-exclamation-triangle mr-1"></i>
                            <strong>適用範囲:</strong> マイク録音、ファイルアップロード、テキスト貼り付けすべてに適用されます
                        </p>
                    </div>
                </div>
                
                <!-- Next Step Guidance -->
                <div id="nextStepGuide" class="mt-6 p-4 bg-blue-50 border-l-4 border-blue-600 rounded hidden">
                    <p class="text-sm text-gray-700">
                        <i class="fas fa-check-circle text-green-600 mr-2"></i>
                        入力が完了しました。次は<strong>Scene Split</strong>タブでシーン分割を実行してください。
                    </p>
                </div>
            </div>

            <!-- Scene Split Tab -->
            <div id="contentSceneSplit" class="hidden">
                <h2 class="text-xl font-bold text-gray-800 mb-6">
                    <i class="fas fa-cut mr-2 text-purple-600"></i>
                    シーン分割・編集
                </h2>
                
                <!-- Guide (no source) -->
                <div id="sceneSplitGuide" class="p-6 bg-yellow-50 border-l-4 border-yellow-600 rounded-lg hidden">
                    <div class="flex items-start">
                        <i class="fas fa-exclamation-triangle text-yellow-600 text-2xl mr-4 mt-1"></i>
                        <div>
                            <h3 class="font-semibold text-gray-800 mb-2">入力が必要です</h3>
                            <p class="text-sm text-gray-700 mb-4">
                                シーン分割を実行するには、まず音声ファイルをアップロードするか、テキストを入力してください。
                            </p>
                            <button 
                                onclick="switchTab('input')"
                                class="px-4 py-2 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 transition-colors touch-manipulation"
                            >
                                <i class="fas fa-arrow-left mr-2"></i>Inputタブへ戻る
                            </button>
                        </div>
                    </div>
                </div>
                
                <!-- Character Pre-Registration Warning (Phase F-5) -->
                <div id="characterWarningSection" class="mb-6 p-4 bg-amber-50 rounded-lg border-2 border-amber-400 hidden">
                    <div class="flex items-start gap-4">
                        <i class="fas fa-exclamation-triangle text-amber-600 text-2xl flex-shrink-0 mt-1"></i>
                        <div class="flex-1">
                            <h3 class="font-bold text-amber-800 mb-2">
                                <i class="fas fa-users mr-2"></i>キャラクター事前登録のお勧め
                            </h3>
                            <p class="text-sm text-amber-700 mb-3">
                                シーン分割前にキャラクターを登録しておくと、<strong>自動割り当ての精度が大幅に向上</strong>します。
                            </p>
                            <div class="bg-white p-3 rounded border border-amber-300 mb-3">
                                <p class="text-xs text-gray-700 mb-2">
                                    <strong>推奨手順:</strong>
                                </p>
                                <ol class="text-xs text-gray-600 space-y-1 list-decimal list-inside">
                                    <li><strong>Styles</strong>タブ → <strong>Characters</strong>セクションでキャラを登録</li>
                                    <li>参照画像を設定すると外見の一貫性が向上</li>
                                    <li>エイリアス（別名）を設定すると検出精度が向上</li>
                                </ol>
                            </div>
                            <div class="flex flex-wrap gap-2">
                                <button 
                                    onclick="switchTab('styles')"
                                    class="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition-colors text-sm font-semibold"
                                >
                                    <i class="fas fa-users mr-2"></i>Stylesでキャラ登録
                                </button>
                                <span id="characterCountBadge" class="inline-flex items-center px-3 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm">
                                    <i class="fas fa-user-check mr-2"></i>登録済み: <span id="registeredCharacterCount">0</span>人
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- Format Button -->
                <div id="formatSection" class="mb-6 p-4 bg-purple-50 rounded-lg border-l-4 border-purple-600 hidden">
                    <div class="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                        <div>
                            <h3 class="font-semibold text-gray-800 mb-1">RILARCシナリオ生成</h3>
                            <p class="text-sm text-gray-600">OpenAI Chat APIで入力テキストをシーン分割します（30秒-1分）</p>
                        </div>
                        <button 
                            id="formatBtn"
                            onclick="formatAndSplit()"
                            class="px-6 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-semibold whitespace-nowrap touch-manipulation"
                        >
                            <i class="fas fa-magic mr-2"></i>シーン分割を実行
                        </button>
                    </div>
                </div>
                
                <!-- Character Traits Summary (Phase X-5) -->
                <div id="characterTraitsSummarySection" class="mb-6 hidden">
                    <div class="bg-gradient-to-r from-indigo-50 to-purple-50 rounded-lg border border-indigo-200 p-4">
                        <div class="flex items-center justify-between mb-3">
                            <h3 class="font-semibold text-indigo-800">
                                <i class="fas fa-user-tag mr-2"></i>キャラクター特徴（物語全体）
                            </h3>
                            <button 
                                onclick="toggleCharacterTraitsSummary()"
                                class="text-sm text-indigo-600 hover:text-indigo-800"
                                id="toggleTraitsSummaryBtn"
                            >
                                <i class="fas fa-chevron-down mr-1"></i>詳細
                            </button>
                        </div>
                        <div id="characterTraitsSummaryContent" class="hidden space-y-3">
                            <p class="text-xs text-gray-600 mb-2">
                                物語から抽出された共通特徴と、シーン別のオーバーライドを表示します。
                                画像生成時、シーン別オーバーライドがあればそれが優先されます。
                            </p>
                            <div id="characterTraitsList" class="space-y-2">
                                <!-- Populated by JS -->
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- Scenes Table -->
                <div id="scenesSection" class="hidden">
                    <div class="flex items-center justify-between mb-4">
                        <h3 class="text-lg font-semibold text-gray-800">
                            シーン一覧（<span id="scenesCount">0</span>件）
                        </h3>
                        <div class="flex gap-2">
                            <button 
                                id="resetToInputBtnSmall"
                                onclick="showResetToInputModal()"
                                class="px-4 py-2 bg-orange-100 text-orange-700 rounded-lg hover:bg-orange-200 transition-colors font-semibold touch-manipulation"
                                title="入力からやり直す"
                            >
                                <i class="fas fa-undo mr-1"></i>やり直す
                            </button>
                            <button 
                                id="goToBuilderBtn"
                                onclick="goToBuilder()"
                                class="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-semibold touch-manipulation hidden"
                            >
                                <i class="fas fa-arrow-right mr-2"></i>Builderへ進む
                            </button>
                        </div>
                    </div>
                    
                    <div id="scenesList" class="space-y-4">
                        <!-- Scenes will be rendered here -->
                    </div>
                </div>
                
                <!-- Empty State -->
                <div id="scenesEmptyState" class="text-center py-12 hidden">
                    <i class="fas fa-inbox text-6xl text-gray-300 mb-4"></i>
                    <p class="text-gray-600">シーンがありません。上の「シーン分割を実行」ボタンを押してください。</p>
                </div>
            </div>

            <!-- Builder Tab -->
            <div id="contentBuilder" class="hidden">
                <h2 class="text-xl font-bold text-gray-800 mb-6">
                    <i class="fas fa-image mr-2 text-blue-600"></i>
                    制作ボード（Builder）
                </h2>
                
                <!-- Top Action Bar (Phase F-5: Improved workflow order) -->
                <div class="mb-6 p-4 bg-gray-50 rounded-lg border-2 border-gray-200">
                    <!-- Workflow Guide -->
                    <div class="mb-4 p-3 bg-blue-50 rounded-lg border border-blue-200">
                        <p class="text-sm text-blue-800">
                            <i class="fas fa-info-circle mr-2"></i>
                            <strong>推奨ワークフロー:</strong>
                            ① キャラ割り当て → ② スタイル設定 → ③ 画像生成
                        </p>
                    </div>
                    
                    <!-- Step 1: Character Auto-Assign -->
                    <div class="mb-4 pb-4 border-b border-gray-300">
                        <div class="flex items-center justify-between">
                            <div>
                                <label class="block text-sm font-semibold text-gray-700 mb-1">
                                    <span class="inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-600 text-white text-xs mr-2">1</span>
                                    <i class="fas fa-users mr-1 text-blue-600"></i>キャラクター自動割り当て
                                </label>
                                <p class="text-xs text-gray-500 ml-7">各シーンのセリフから登場キャラクターを自動判定</p>
                            </div>
                            <button id="btnAutoAssignRerun"
                                class="px-4 py-2 rounded-lg font-semibold bg-blue-600 text-white hover:bg-blue-700 transition-colors whitespace-nowrap">
                                <i class="fas fa-sync-alt mr-2"></i>
                                Auto-Assign 実行
                            </button>
                        </div>
                        <p class="text-xs text-amber-600 mt-2 ml-7">
                            <i class="fas fa-lightbulb mr-1"></i>
                            キャラクターを事前登録すると割り当て精度が向上します
                            <button onclick="switchTab('styles')" class="underline ml-1">Stylesで登録</button>
                        </p>
                    </div>
                    
                    <!-- Step 2: Bulk Style Selection -->
                    <div class="mb-4 pb-4 border-b border-gray-300">
                        <label class="block text-sm font-semibold text-gray-700 mb-2">
                            <span class="inline-flex items-center justify-center w-5 h-5 rounded-full bg-purple-600 text-white text-xs mr-2">2</span>
                            <i class="fas fa-palette mr-1 text-purple-600"></i>一括スタイル設定
                        </label>
                        <div class="flex flex-col sm:flex-row gap-2 ml-7">
                            <select 
                                id="bulkStyleSelector"
                                class="flex-1 px-3 py-2 border-2 border-gray-300 rounded-lg focus:border-purple-500 focus:ring-2 focus:ring-purple-200 text-sm"
                            >
                                <option value="">未設定（プロジェクトデフォルト）</option>
                            </select>
                            <button 
                                onclick="applyBulkStyle()"
                                class="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-semibold whitespace-nowrap"
                            >
                                <i class="fas fa-check mr-2"></i>全シーンに適用
                            </button>
                        </div>
                        <p class="text-xs text-gray-500 mt-1 ml-7">すべてのシーンに同じスタイルを一括設定できます</p>
                    </div>
                    
                    <!-- Step 3: Image Generation -->
                    <div class="mb-4 pb-4 border-b border-gray-300">
                        <label class="block text-sm font-semibold text-gray-700 mb-2">
                            <span class="inline-flex items-center justify-center w-5 h-5 rounded-full bg-green-600 text-white text-xs mr-2">3</span>
                            <i class="fas fa-image mr-1 text-green-600"></i>画像生成
                        </label>
                        <div class="flex flex-wrap gap-2 ml-7">
                            <button 
                                id="generateAllImagesBtn"
                                onclick="generateBulkImages('all')"
                                class="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-semibold touch-manipulation"
                            >
                                <i class="fas fa-magic mr-2"></i>全画像生成
                            </button>
                            <button 
                                id="generatePendingImagesBtn"
                                onclick="generateBulkImages('pending')"
                                class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-semibold touch-manipulation"
                            >
                                <i class="fas fa-plus-circle mr-2"></i>未生成のみ
                            </button>
                            <button 
                                id="generateFailedImagesBtn"
                                onclick="generateBulkImages('failed')"
                                class="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors font-semibold touch-manipulation"
                            >
                                <i class="fas fa-redo mr-2"></i>失敗のみ
                            </button>
                        </div>
                        <p class="text-xs text-gray-500 mt-1 ml-7">キャラクター参照画像が設定されていると一貫性が向上します</p>
                    </div>
                    
                    <div class="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                        <!-- Status Summary -->
                        <div id="builderStatusSummary" class="text-sm text-gray-600">
                            <!-- Will be populated by JS -->
                        </div>
                        
                        <!-- Export Navigation -->
                        <div class="flex items-center gap-3">
                            <span class="text-sm text-gray-600">書き出しは →</span>
                            <button 
                                onclick="switchTab('export')"
                                class="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-semibold touch-manipulation flex items-center gap-2"
                            >
                                <i class="fas fa-download"></i>
                                Exportタブへ
                            </button>
                        </div>
                    </div>
                </div>
                
                <!-- Scene Cards -->
                <div id="builderScenesList" class="space-y-6">
                    <!-- Scene cards will be rendered here -->
                </div>
                
                <!-- Empty State -->
                <div id="builderEmptyState" class="text-center py-12 hidden">
                    <i class="fas fa-inbox text-6xl text-gray-300 mb-4"></i>
                    <p class="text-gray-600">シーンがありません。Scene Splitタブでシーンを作成してください。</p>
                </div>
            </div>

            <!-- Export Tab -->
            <div id="contentExport" class="hidden">
                <h2 class="text-xl font-bold text-gray-800 mb-6">
                    <i class="fas fa-download mr-2 text-green-600"></i>
                    書き出し（Export）
                </h2>
                
                <!-- Project Summary -->
                <div class="mb-6 p-6 bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg border-2 border-blue-200">
                    <h3 class="text-lg font-bold text-gray-800 mb-3 flex items-center">
                        <i class="fas fa-film mr-2 text-blue-600"></i>
                        このプロジェクトの書き出し
                    </h3>
                    <div class="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                        <div>
                            <span class="text-gray-600">プロジェクト名:</span>
                            <p class="font-semibold text-gray-800" id="exportProjectTitle">-</p>
                        </div>
                        <div>
                            <span class="text-gray-600">作成日:</span>
                            <p class="font-semibold text-gray-800" id="exportCreatedAt">-</p>
                        </div>
                        <div>
                            <span class="text-gray-600">シーン数:</span>
                            <p class="font-semibold text-gray-800" id="exportSceneCount">-</p>
                        </div>
                    </div>
                </div>
                
                <!-- Export Options -->
                <div class="space-y-4">
                    <!-- Images ZIP -->
                    <div class="bg-white rounded-lg border-2 border-gray-200 p-6 hover:border-blue-400 transition-colors">
                        <div class="flex items-start justify-between gap-4">
                            <div class="flex-1">
                                <h3 class="text-lg font-bold text-gray-800 mb-2 flex items-center">
                                    <i class="fas fa-images mr-2 text-blue-600"></i>
                                    画像素材
                                </h3>
                                <p class="text-sm font-semibold text-blue-700 mb-1">YouTube動画用 画像素材（全シーン）</p>
                                <p class="text-sm text-gray-600">サムネ・動画編集にそのまま使えます</p>
                            </div>
                            <button 
                                onclick="downloadImages()"
                                class="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-semibold whitespace-nowrap touch-manipulation flex items-center gap-2"
                            >
                                <i class="fas fa-download"></i>
                                images.zip
                            </button>
                        </div>
                    </div>
                    
                    <!-- Dialogue CSV -->
                    <div class="bg-white rounded-lg border-2 border-gray-200 p-6 hover:border-green-400 transition-colors">
                        <div class="flex items-start justify-between gap-4">
                            <div class="flex-1">
                                <h3 class="text-lg font-bold text-gray-800 mb-2 flex items-center">
                                    <i class="fas fa-file-csv mr-2 text-green-600"></i>
                                    シナリオ
                                </h3>
                                <p class="text-sm font-semibold text-green-700 mb-1">ナレーション・字幕用 シナリオ</p>
                                <p class="text-sm text-gray-600">VOICEVOX / 台本 / 外注共有用</p>
                            </div>
                            <button 
                                onclick="downloadCSV()"
                                class="px-6 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-semibold whitespace-nowrap touch-manipulation flex items-center gap-2"
                            >
                                <i class="fas fa-download"></i>
                                dialogue.csv
                            </button>
                        </div>
                    </div>
                    
                    <!-- All ZIP -->
                    <div class="bg-white rounded-lg border-2 border-purple-200 p-6 hover:border-purple-400 transition-colors">
                        <div class="flex items-start justify-between gap-4">
                            <div class="flex-1">
                                <h3 class="text-lg font-bold text-gray-800 mb-2 flex items-center">
                                    <i class="fas fa-archive mr-2 text-purple-600"></i>
                                    全素材パック
                                </h3>
                                <p class="text-sm font-semibold text-purple-700 mb-1">動画制作フルパック</p>
                                <p class="text-sm text-gray-600">編集者・外注にそのまま渡せます</p>
                                <div class="mt-2 text-xs text-gray-500">
                                    <span class="inline-block mr-2">📁 画像素材（全シーン）</span>
                                    <span class="inline-block mr-2">📄 dialogue.csv</span>
                                    <span class="inline-block">📋 project.json</span>
                                </div>
                            </div>
                            <button 
                                onclick="downloadAll()"
                                class="px-6 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-semibold whitespace-nowrap touch-manipulation flex items-center gap-2"
                            >
                                <i class="fas fa-download"></i>
                                all.zip
                            </button>
                        </div>
                    </div>
                </div>
                
                <!-- Usage Tips -->
                <div class="mt-6 p-4 bg-blue-50 border-l-4 border-blue-600 rounded">
                    <h4 class="font-semibold text-gray-800 mb-2 flex items-center">
                        <i class="fas fa-lightbulb mr-2 text-yellow-500"></i>
                        使い方のヒント
                    </h4>
                    <ul class="text-sm text-gray-700 space-y-1">
                        <li>• <strong>images.zip</strong>: Premiere Pro / DaVinci Resolve 等の動画編集ソフトで直接使用</li>
                        <li>• <strong>dialogue.csv</strong>: VOICEVOX でナレーション生成、または外注ナレーターへの台本として活用</li>
                        <li>• <strong>all.zip</strong>: 動画編集を外注する際にこのファイル1つを渡すだけでOK</li>
                    </ul>
                </div>
            </div>

            <!-- Video Build Tab (Phase B-3) -->
            <div id="contentVideoBuild" class="hidden">
                <h2 class="text-xl font-bold text-gray-800 mb-6">
                    <i class="fas fa-film mr-2 text-purple-600"></i>
                    動画生成（Video Build）
                </h2>
                
                <!-- Usage Status -->
                <div id="videoBuildUsage" class="mb-6 p-4 bg-gradient-to-r from-purple-50 to-blue-50 rounded-lg border border-purple-200">
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-4">
                            <div>
                                <span class="text-sm text-gray-600">今月の生成回数:</span>
                                <span id="videoBuildUsageCount" class="ml-2 font-bold text-purple-700">-</span>
                                <span class="text-gray-500">/ 30</span>
                            </div>
                            <div class="w-px h-8 bg-gray-300"></div>
                            <div>
                                <span class="text-sm text-gray-600">同時実行:</span>
                                <span id="videoBuildConcurrent" class="ml-2 font-bold text-blue-700">0</span>
                                <span class="text-gray-500">/ 1</span>
                            </div>
                        </div>
                        <button 
                            onclick="refreshVideoBuildUsage()"
                            class="text-purple-600 hover:text-purple-800 transition-colors"
                            title="更新"
                        >
                            <i class="fas fa-sync-alt"></i>
                        </button>
                    </div>
                </div>

                <!-- Create New Video Build -->
                <div class="mb-6 p-6 bg-white rounded-lg border-2 border-purple-200 hover:border-purple-400 transition-colors">
                    <div class="flex items-start justify-between gap-4">
                        <div class="flex-1">
                            <h3 class="text-lg font-bold text-gray-800 mb-2 flex items-center">
                                <i class="fas fa-rocket mr-2 text-purple-600"></i>
                                新しい動画を生成
                            </h3>
                            <p class="text-sm text-gray-600 mb-2">
                                このプロジェクトの全シーンから動画を自動生成します。
                            </p>
                            <div id="videoBuildRequirements" class="text-sm space-y-1">
                                <!-- Requirements will be populated by JS -->
                            </div>
                        </div>
                        <button 
                            id="btnStartVideoBuild"
                            onclick="startVideoBuild()"
                            class="px-6 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-semibold whitespace-nowrap touch-manipulation flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                            disabled
                        >
                            <i class="fas fa-film"></i>
                            動画生成を開始
                        </button>
                    </div>
                    
                    <!-- Build Settings -->
                    <div class="mt-4 pt-4 border-t border-gray-200">
                        <h4 class="text-sm font-semibold text-gray-700 mb-3">
                            <i class="fas fa-cog mr-1"></i>
                            生成オプション
                        </h4>
                        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <label class="flex items-center gap-2 cursor-pointer">
                                <input type="checkbox" id="videoBuildCaptions" checked class="w-4 h-4 text-purple-600 rounded">
                                <span class="text-sm text-gray-700">字幕を表示</span>
                            </label>
                            <label class="flex items-center gap-2 cursor-pointer">
                                <input type="checkbox" id="videoBuildBgm" class="w-4 h-4 text-purple-600 rounded">
                                <span class="text-sm text-gray-700">BGMを追加</span>
                            </label>
                            <label class="flex items-center gap-2 cursor-pointer">
                                <input type="checkbox" id="videoBuildMotion" checked class="w-4 h-4 text-purple-600 rounded">
                                <span class="text-sm text-gray-700">Ken Burnsエフェクト</span>
                            </label>
                        </div>
                    </div>
                </div>
                
                <!-- Current Build Progress (shown when build is in progress) -->
                <div id="videoBuildProgress" class="hidden mb-6 p-6 bg-white rounded-lg border-2 border-blue-200">
                    <div class="flex items-center justify-between mb-4">
                        <h3 class="text-lg font-bold text-gray-800 flex items-center">
                            <span id="videoBuildProgressIcon" class="mr-2">🎬</span>
                            <span id="videoBuildProgressTitle">レンダリング中...</span>
                        </h3>
                        <span id="videoBuildProgressPercent" class="text-2xl font-bold text-blue-600">0%</span>
                    </div>
                    
                    <!-- Progress Bar -->
                    <div class="w-full bg-gray-200 rounded-full h-4 mb-3 overflow-hidden">
                        <div id="videoBuildProgressBar" class="h-full bg-gradient-to-r from-purple-500 to-blue-500 transition-all duration-500 ease-out" style="width: 0%"></div>
                    </div>
                    
                    <div class="flex items-center justify-between text-sm">
                        <span id="videoBuildProgressStage" class="text-gray-600">準備中...</span>
                        <span id="videoBuildProgressId" class="text-gray-400 font-mono text-xs"></span>
                    </div>
                </div>
                
                <!-- Build History -->
                <div class="bg-white rounded-lg border-2 border-gray-200">
                    <div class="flex items-center justify-between p-4 border-b border-gray-200">
                        <h3 class="text-lg font-bold text-gray-800 flex items-center">
                            <i class="fas fa-history mr-2 text-gray-600"></i>
                            生成履歴
                        </h3>
                        <button 
                            onclick="loadVideoBuilds()"
                            class="text-gray-600 hover:text-gray-800 transition-colors"
                            title="更新"
                        >
                            <i class="fas fa-sync-alt"></i>
                        </button>
                    </div>
                    
                    <div id="videoBuildList" class="divide-y divide-gray-200">
                        <!-- Video builds will be rendered here -->
                    </div>
                    
                    <div id="videoBuildListEmpty" class="hidden p-8 text-center">
                        <i class="fas fa-video-slash text-4xl text-gray-300 mb-3"></i>
                        <p class="text-gray-500">まだ動画を生成していません</p>
                        <p class="text-sm text-gray-400 mt-1">上のボタンから動画生成を開始してください</p>
                    </div>
                    
                    <div id="videoBuildListLoading" class="hidden p-8 text-center">
                        <i class="fas fa-spinner fa-spin text-4xl text-purple-600 mb-3"></i>
                        <p class="text-gray-600">読み込み中...</p>
                    </div>
                </div>
            </div>

            <!-- Styles Tab -->
            <div id="contentStyles" class="hidden">
                <h2 class="text-xl font-bold text-gray-800 mb-6">
                    <i class="fas fa-palette mr-2 text-purple-600"></i>
                    スタイル・シーン・キャラクター設定
                </h2>
                
                <!-- Phase X-5: World & Characters Panel (moved from Builder) -->
                <div id="world-characters-panel-styles" class="border-2 border-gray-200 rounded-lg p-6 bg-white mb-6">
                    <div class="space-y-6">
                        <!-- Scene Split Settings Section -->
                        <div>
                            <h2 class="text-lg font-bold text-gray-800 mb-4">
                                <i class="fas fa-cut mr-2 text-indigo-600"></i>
                                Scene Split Settings
                            </h2>
                            <p class="text-sm text-gray-600 mb-4">
                                シーン分割の設定を行います。<strong>Format実行前</strong>に設定してください。
                            </p>
                            
                            <div class="bg-gray-50 rounded-lg p-4 space-y-4">
                                <!-- Target Scene Count -->
                                <div>
                                    <label for="targetSceneCount" class="block text-sm font-medium text-gray-700 mb-2">
                                        Target Scene Count
                                    </label>
                                    <div class="flex flex-wrap items-center gap-2 mb-2">
                                        <button data-preset="15" class="split-preset px-3 py-1 rounded bg-gray-200 hover:bg-blue-500 hover:text-white text-sm font-medium transition-colors">15</button>
                                        <button data-preset="20" class="split-preset px-3 py-1 rounded bg-blue-500 text-white text-sm font-medium">20</button>
                                        <button data-preset="30" class="split-preset px-3 py-1 rounded bg-gray-200 hover:bg-blue-500 hover:text-white text-sm font-medium transition-colors">30</button>
                                        <button data-preset="45" class="split-preset px-3 py-1 rounded bg-gray-200 hover:bg-blue-500 hover:text-white text-sm font-medium transition-colors">45</button>
                                        <button data-preset="60" class="split-preset px-3 py-1 rounded bg-gray-200 hover:bg-blue-500 hover:text-white text-sm font-medium transition-colors border-2 border-orange-300" title="長文向け（10,000字以上推奨）">60</button>
                                        <button data-preset="100" class="split-preset px-3 py-1 rounded bg-gray-200 hover:bg-blue-500 hover:text-white text-sm font-medium transition-colors border-2 border-orange-300" title="超長文向け（15,000字以上推奨）">100</button>
                                        <span class="text-gray-500 mx-2">or</span>
                                        <input type="number" id="targetSceneCount" 
                                            class="w-20 px-2 py-1 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-blue-500"
                                            min="5" max="200" value="20">
                                    </div>
                                    <p class="text-xs text-gray-500">
                                        ⚠️ 目標値です（必ずこの数にはなりません）。プリセットクリックで自動調整されます。
                                    </p>
                                    <p class="text-xs text-amber-600 mt-1">
                                        💡 <strong>入力が短い場合は自動的に下限（5シーン程度）になります。</strong>より細かく分割したい場合は、入力テキストを増やしてください。
                                    </p>
                                    <p class="text-xs text-orange-600 mt-1">
                                        🔶 <strong>60/100シーンは長文向け</strong>（10,000字以上推奨）。短い入力では期待した数になりません。
                                    </p>
                                </div>

                                <!-- Pacing -->
                                <div>
                                    <label class="block text-sm font-medium text-gray-700 mb-2">
                                        Pacing
                                    </label>
                                    <div class="flex items-center gap-2">
                                        <button data-pacing="fast" class="pacing-btn px-3 py-1 rounded bg-gray-200 hover:bg-green-500 hover:text-white text-sm font-medium transition-colors">Fast</button>
                                        <button data-pacing="normal" class="pacing-btn px-3 py-1 rounded bg-green-500 text-white text-sm font-medium">Normal</button>
                                        <button data-pacing="slow" class="pacing-btn px-3 py-1 rounded bg-gray-200 hover:bg-green-500 hover:text-white text-sm font-medium transition-colors">Slow</button>
                                    </div>
                                    <p class="text-xs text-gray-500 mt-1">Fast: テンポ重視 / Normal: バランス / Slow: 詳細重視</p>
                                </div>

                                <!-- Advanced Settings (collapsed) -->
                                <details class="mt-4">
                                    <summary class="text-sm font-medium text-gray-700 cursor-pointer hover:text-blue-600">
                                        <i class="fas fa-cog mr-1"></i>
                                        Advanced Settings
                                    </summary>
                                    <div class="mt-3 space-y-3 pl-4">
                                        <div>
                                            <label for="minChars" class="block text-xs font-medium text-gray-600 mb-1">
                                                Min Chars per Scene
                                            </label>
                                            <input type="number" id="minChars" 
                                                class="w-full px-2 py-1 border border-gray-300 rounded text-xs focus:ring-2 focus:ring-blue-500"
                                                min="100" max="5000" value="600" readonly>
                                            <p class="text-xs text-gray-400 mt-1">プリセット連動（自動設定）</p>
                                        </div>
                                        <div>
                                            <label for="maxChars" class="block text-xs font-medium text-gray-600 mb-1">
                                                Max Chars per Scene
                                            </label>
                                            <input type="number" id="maxChars" 
                                                class="w-full px-2 py-1 border border-gray-300 rounded text-xs focus:ring-2 focus:ring-blue-500"
                                                min="100" max="5000" value="1200" readonly>
                                            <p class="text-xs text-gray-400 mt-1">プリセット連動（自動設定）</p>
                                        </div>
                                    </div>
                                </details>

                                <!-- Save Button -->
                                <div class="pt-2">
                                    <button id="btnSaveSplitSettings"
                                        class="px-4 py-2 rounded-lg font-semibold bg-indigo-600 text-white hover:bg-indigo-700 transition-colors">
                                        <i class="fas fa-save mr-2"></i>
                                        Save Settings
                                    </button>
                                </div>
                            </div>
                        </div>

                        <!-- Characters Section -->
                        <div class="border-t pt-6">
                            <div class="flex items-center justify-between mb-3">
                                <h2 class="text-lg font-bold text-gray-800">
                                    <i class="fas fa-users mr-2 text-blue-600"></i>
                                    Characters
                                </h2>
                                <div class="flex gap-2">
                                    <button id="btnImportFromLibrary"
                                        class="px-4 py-2 rounded-lg font-semibold bg-green-600 text-white hover:bg-green-700 transition-colors">
                                        <i class="fas fa-book mr-2"></i>
                                        マイキャラから追加
                                    </button>
                                    <button id="btnAddCharacter"
                                        class="px-4 py-2 rounded-lg font-semibold bg-blue-600 text-white hover:bg-blue-700 transition-colors">
                                        <i class="fas fa-plus mr-2"></i>
                                        新規作成
                                    </button>
                                </div>
                            </div>
                            <div id="characters-list" class="text-sm text-gray-600">
                                （キャラクター未登録）
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- Project Default Style -->
                <div class="mb-6 p-6 bg-gradient-to-r from-purple-50 to-pink-50 rounded-lg border-2 border-purple-200">
                    <h3 class="text-lg font-bold text-gray-800 mb-3 flex items-center">
                        <i class="fas fa-cog mr-2 text-purple-600"></i>
                        プロジェクトデフォルトスタイル
                    </h3>
                    <p class="text-sm text-gray-600 mb-4">画像生成時に適用されるデフォルトスタイルを選択してください</p>
                    <div class="flex items-center gap-4">
                        <select 
                            id="projectDefaultStyle"
                            class="flex-1 px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-purple-500 focus:ring-2 focus:ring-purple-200 transition-all"
                        >
                            <option value="">未設定（オリジナルプロンプト）</option>
                        </select>
                        <button 
                            onclick="saveProjectDefaultStyle()"
                            class="px-6 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-semibold whitespace-nowrap"
                        >
                            <i class="fas fa-save mr-2"></i>保存
                        </button>
                    </div>
                </div>
                
                <!-- Style Presets List -->
                <div class="mb-4 flex items-center justify-between">
                    <h3 class="text-lg font-bold text-gray-800">
                        <i class="fas fa-list mr-2 text-gray-600"></i>
                        スタイルプリセット
                    </h3>
                    <button 
                        onclick="showStyleEditor()"
                        class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-semibold"
                    >
                        <i class="fas fa-plus mr-2"></i>新規作成
                    </button>
                </div>
                
                <div id="stylePresetsList" class="space-y-3">
                    <!-- Styles will be rendered here -->
                </div>
                
                <!-- Empty State -->
                <div id="stylesEmptyState" class="text-center py-12 hidden">
                    <i class="fas fa-palette text-6xl text-gray-300 mb-4"></i>
                    <p class="text-gray-600 mb-4">スタイルプリセットがありません</p>
                    <button 
                        onclick="showStyleEditor()"
                        class="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-semibold"
                    >
                        <i class="fas fa-plus mr-2"></i>最初のスタイルを作成
                    </button>
                </div>
            </div>
        </div>

        <!-- Toast Notification -->
        <div id="toast" class="fixed top-4 right-4 bg-white shadow-lg rounded-lg p-4 hidden z-50 max-w-md">
            <div class="flex items-center">
                <i id="toastIcon" class="fas fa-check-circle text-2xl mr-3 text-green-500"></i>
                <span id="toastMessage" class="text-gray-800"></span>
            </div>
        </div>
        
        <!-- Image History Modal -->
        <div id="imageHistoryModal" class="fixed inset-0 bg-black bg-opacity-50 hidden z-50 flex items-center justify-center p-4">
            <div class="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-hidden">
                <div class="flex items-center justify-between p-6 border-b">
                    <h3 class="text-xl font-bold text-gray-800">
                        <i class="fas fa-history mr-2 text-blue-600"></i>
                        画像生成履歴
                    </h3>
                    <button 
                        onclick="closeImageHistory()"
                        class="text-gray-500 hover:text-gray-700 transition-colors"
                    >
                        <i class="fas fa-times text-2xl"></i>
                    </button>
                </div>
                <div id="imageHistoryContent" class="p-6 overflow-y-auto max-h-[70vh]">
                    <!-- History will be rendered here -->
                </div>
            </div>
        </div>
        
        <!-- Style Editor Modal -->
        <div id="styleEditorModal" class="fixed inset-0 bg-black bg-opacity-50 hidden z-50 flex items-center justify-center p-4">
            <div class="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-hidden">
                <div class="flex items-center justify-between p-6 border-b">
                    <h3 class="text-xl font-bold text-gray-800">
                        <i class="fas fa-palette mr-2 text-purple-600"></i>
                        <span id="styleEditorTitle">スタイル編集</span>
                    </h3>
                    <button 
                        onclick="closeStyleEditor()"
                        class="text-gray-500 hover:text-gray-700 transition-colors"
                    >
                        <i class="fas fa-times text-2xl"></i>
                    </button>
                </div>
                <div class="p-6 overflow-y-auto max-h-[70vh]">
                    <form id="styleEditorForm" class="space-y-4">
                        <input type="hidden" id="editingStyleId" value="">
                        
                        <div>
                            <label class="block text-sm font-semibold text-gray-700 mb-2">
                                スタイル名 <span class="text-red-500">*</span>
                            </label>
                            <input 
                                type="text" 
                                id="styleName"
                                class="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-purple-500 focus:ring-2 focus:ring-purple-200"
                                placeholder="例: 日本アニメ風"
                                required
                            >
                        </div>
                        
                        <div>
                            <label class="block text-sm font-semibold text-gray-700 mb-2">
                                説明
                            </label>
                            <textarea 
                                id="styleDescription"
                                rows="2"
                                class="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-purple-500 focus:ring-2 focus:ring-purple-200"
                                placeholder="このスタイルの説明を入力"
                            ></textarea>
                        </div>
                        
                        <div>
                            <label class="block text-sm font-semibold text-gray-700 mb-2">
                                プロンプト接頭辞（Prefix）
                                <span class="ml-2 text-xs font-normal text-blue-600">日本語OK</span>
                            </label>
                            <textarea 
                                id="stylePromptPrefix"
                                rows="3"
                                class="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-purple-500 focus:ring-2 focus:ring-purple-200 font-mono text-sm"
                                placeholder="例: 日本のアニメ風、鮮やかな色彩"
                            ></textarea>
                            <p class="text-xs text-gray-500 mt-1">画像プロンプトの<strong>前</strong>に追加されます（スタイルや雰囲気の指定に使用）</p>
                        </div>
                        
                        <div>
                            <label class="block text-sm font-semibold text-gray-700 mb-2">
                                プロンプト接尾辞（Suffix）
                                <span class="ml-2 text-xs font-normal text-blue-600">日本語OK</span>
                            </label>
                            <textarea 
                                id="stylePromptSuffix"
                                rows="3"
                                class="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-purple-500 focus:ring-2 focus:ring-purple-200 font-mono text-sm"
                                placeholder="例: 高品質、詳細、4K解像度"
                            ></textarea>
                            <p class="text-xs text-gray-500 mt-1">画像プロンプトの<strong>後</strong>に追加されます（品質やカメラアングルの指定に使用）</p>
                        </div>
                        
                        <div>
                            <label class="block text-sm font-semibold text-gray-700 mb-2">
                                ネガティブプロンプト
                                <span class="ml-2 text-xs font-normal text-blue-600">日本語OK</span>
                            </label>
                            <textarea 
                                id="styleNegativePrompt"
                                rows="2"
                                class="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-purple-500 focus:ring-2 focus:ring-purple-200 font-mono text-sm"
                                placeholder="例: ぼやけ、低品質、歪み"
                            ></textarea>
                            <p class="text-xs text-gray-500 mt-1">画像生成時に除外する要素（現在Geminiでは未対応）</p>
                        </div>
                        
                        <div class="flex items-center">
                            <input 
                                type="checkbox" 
                                id="styleIsActive"
                                class="w-5 h-5 text-purple-600 border-gray-300 rounded focus:ring-purple-500"
                                checked
                            >
                            <label for="styleIsActive" class="ml-2 text-sm font-semibold text-gray-700">
                                有効化
                            </label>
                        </div>
                        
                        <div class="flex gap-3 pt-4">
                            <button 
                                type="button"
                                onclick="saveStylePreset()"
                                class="flex-1 px-6 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-semibold"
                            >
                                <i class="fas fa-save mr-2"></i>保存
                            </button>
                            <button 
                                type="button"
                                onclick="closeStyleEditor()"
                                class="px-6 py-3 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition-colors font-semibold"
                            >
                                キャンセル
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    </div>

    <!-- Phase 2-3: Scene Edit Modal -->
    <div id="scene-edit-modal" class="hidden fixed inset-0 bg-black bg-opacity-50 z-50" style="overflow-y: auto;">
        <div class="min-h-screen px-4 py-8 flex items-start justify-center">
            <div class="bg-white rounded-xl shadow-2xl w-full max-w-4xl">
                <!-- Header -->
                <div class="bg-gradient-to-r from-blue-600 to-purple-600 px-6 py-4 rounded-t-xl">
                    <h2 class="text-2xl font-bold text-white">
                        <i class="fas fa-edit mr-2"></i>シーン編集
                    </h2>
                </div>
                
                <!-- Content -->
                <div class="p-6 space-y-4" style="max-height: 70vh; overflow-y: auto;">
                    <!-- Scene ID (hidden) -->
                    <input type="hidden" id="edit-scene-id" />
                    
                    <!-- Basic Info Section (always visible) -->
                    <div class="space-y-4 pb-4 border-b border-gray-200">
                        <!-- Dialogue -->
                        <div>
                            <label class="block text-sm font-semibold text-gray-700 mb-2">
                                <i class="fas fa-comment mr-1 text-blue-600"></i>セリフ
                            </label>
                            <textarea 
                                id="edit-dialogue"
                                rows="3"
                                class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                                placeholder="セリフを入力..."
                            ></textarea>
                        </div>
                        
                        <!-- Image Prompt -->
                        <div>
                            <label class="block text-sm font-semibold text-gray-700 mb-2">
                                <i class="fas fa-image mr-1 text-purple-600"></i>画像プロンプト
                            </label>
                            <textarea 
                                id="edit-image-prompt"
                                rows="2"
                                class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                                placeholder="例: A beautiful forest scene."
                            ></textarea>
                        </div>
                    </div>
                    
                    <!-- Tab Navigation (SSOT: single modal, two tabs) -->
                    <div id="scene-edit-tabs">
                        <!-- Dynamically populated -->
                    </div>
                    
                    <!-- Tab A: Character Assignment -->
                    <div id="scene-edit-tab-characters" class="space-y-4">
                        <!-- Dynamically populated -->
                    </div>
                    
                    <!-- Tab B: Character Traits -->
                    <div id="scene-edit-tab-traits" class="hidden space-y-4">
                        <!-- Dynamically populated -->
                    </div>
                </div>
                
                <!-- Footer -->
                <div class="bg-gray-50 px-6 py-4 rounded-b-xl flex gap-3 justify-end">
                    <button 
                        id="cancel-edit-scene"
                        class="px-6 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition-colors font-semibold"
                    >
                        閉じる
                    </button>
                    <button 
                        id="save-edit-scene"
                        class="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <i class="fas fa-check mr-2"></i>変更なし
                    </button>
                </div>
            </div>
        </div>
    </div>

    <!-- Phase X-5: Character Trait Edit Modal (Improved) -->
    <div id="character-trait-modal" class="hidden fixed inset-0 bg-black bg-opacity-50 z-50 overflow-y-auto">
        <div class="min-h-screen px-4 py-8 flex items-start justify-center">
            <div class="bg-white rounded-xl shadow-2xl w-full max-w-2xl">
                <!-- Header -->
                <div class="bg-gradient-to-r from-indigo-600 to-purple-600 px-6 py-4 rounded-t-xl">
                    <h2 id="trait-modal-title" class="text-xl font-bold text-white">
                        <i class="fas fa-user-tag mr-2"></i>キャラクター特徴を編集
                    </h2>
                </div>
                
                <!-- Content -->
                <div class="p-6 space-y-4">
                    <!-- Hidden fields -->
                    <input type="hidden" id="trait-modal-character-key" />
                    <input type="hidden" id="trait-modal-scene-id" />
                    <input type="hidden" id="trait-modal-mode" /> <!-- 'story', 'scene', or 'select' -->
                    
                    <!-- Step 1: Character Selection (for scene override) -->
                    <div id="trait-modal-step-select" class="hidden space-y-4">
                        <div class="p-4 bg-blue-50 rounded-lg border border-blue-200">
                            <p class="text-sm text-blue-700">
                                <i class="fas fa-info-circle mr-1"></i>
                                <strong>シーン別オーバーライド</strong>を設定するキャラクターを選択してください。<br>
                                変身・衣装変更・状態変化など、このシーンでのみ異なる描写が必要なキャラクターを選びます。
                            </p>
                        </div>
                        
                        <div>
                            <label class="block text-sm font-semibold text-gray-700 mb-2">
                                <i class="fas fa-users mr-1 text-indigo-600"></i>キャラクターを選択
                            </label>
                            <div id="trait-modal-character-list" class="space-y-2">
                                <!-- Character cards will be inserted here -->
                            </div>
                        </div>
                        
                        <!-- Example section -->
                        <div class="mt-4">
                            <label class="block text-sm font-semibold text-gray-700 mb-2">
                                <i class="fas fa-lightbulb mr-1 text-yellow-500"></i>シーン別特徴を設定する場面の例
                            </label>
                            <div class="grid grid-cols-2 gap-2 text-sm">
                                <div class="p-2 bg-yellow-50 rounded border border-yellow-200">
                                    <span class="font-semibold text-yellow-800">変身・変化</span>
                                    <p class="text-yellow-700 text-xs mt-1">妖精→人間への変身</p>
                                </div>
                                <div class="p-2 bg-green-50 rounded border border-green-200">
                                    <span class="font-semibold text-green-800">衣装・装備</span>
                                    <p class="text-green-700 text-xs mt-1">鎧を着る、武器を持つ</p>
                                </div>
                                <div class="p-2 bg-red-50 rounded border border-red-200">
                                    <span class="font-semibold text-red-800">状態変化</span>
                                    <p class="text-red-700 text-xs mt-1">傷・疲労・感情の変化</p>
                                </div>
                                <div class="p-2 bg-blue-50 rounded border border-blue-200">
                                    <span class="font-semibold text-blue-800">時間経過</span>
                                    <p class="text-blue-700 text-xs mt-1">成長後・数年後の姿</p>
                                </div>
                            </div>
                        </div>
                    </div>
                    
                    <!-- Step 2: Trait Edit (shared with story trait edit) -->
                    <div id="trait-modal-step-edit" class="space-y-4">
                        <!-- Character info -->
                        <div class="flex items-center gap-4 p-4 bg-gray-50 rounded-lg">
                            <img id="trait-modal-char-image" src="" alt="" class="w-16 h-16 rounded-full object-cover border-2 border-indigo-200 hidden">
                            <div id="trait-modal-char-placeholder" class="w-16 h-16 rounded-full bg-gray-200 flex items-center justify-center">
                                <i class="fas fa-user text-gray-400 text-2xl"></i>
                            </div>
                            <div>
                                <h3 id="trait-modal-char-name" class="font-bold text-lg text-gray-800">キャラクター名</h3>
                                <p id="trait-modal-char-subtitle" class="text-sm text-gray-500">共通特徴を編集</p>
                            </div>
                        </div>
                    
                    <!-- Mode description -->
                    <div id="trait-modal-description" class="p-4 bg-blue-50 rounded-lg border border-blue-200">
                        <p class="text-sm text-blue-700"></p>
                    </div>
                    
                    <!-- AI suggestion section (for scene override mode) -->
                    <div id="trait-modal-ai-section" class="hidden">
                        <div class="flex items-center justify-between mb-2">
                            <label class="text-sm font-semibold text-gray-700">
                                <i class="fas fa-robot mr-1 text-purple-600"></i>AI検出した特徴
                            </label>
                            <button 
                                id="trait-modal-ai-detect"
                                class="text-xs px-3 py-1 bg-purple-100 text-purple-700 rounded hover:bg-purple-200"
                            >
                                <i class="fas fa-magic mr-1"></i>再検出
                            </button>
                        </div>
                        <div id="trait-modal-ai-suggestions" class="p-3 bg-purple-50 rounded-lg border border-purple-200 text-sm">
                            <i class="fas fa-spinner fa-spin mr-1"></i>検出中...
                        </div>
                        <button 
                            id="trait-modal-use-ai"
                            class="mt-2 text-xs text-purple-600 hover:text-purple-800"
                        >
                            <i class="fas fa-arrow-down mr-1"></i>この内容を使用
                        </button>
                    </div>
                    
                    <!-- Trait input -->
                    <div>
                        <label class="block text-sm font-semibold text-gray-700 mb-2">
                            <i class="fas fa-edit mr-1 text-indigo-600"></i>特徴を入力
                        </label>
                        <textarea 
                            id="trait-modal-input"
                            rows="4"
                            class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm"
                            placeholder="例: 小さな妖精、キラキラと光る羽を持つ、青いドレス"
                        ></textarea>
                    </div>
                    
                    <!-- Examples section (for scene override mode) -->
                    <div id="trait-modal-examples" class="hidden">
                        <label class="block text-sm font-semibold text-gray-700 mb-2">
                            <i class="fas fa-lightbulb mr-1 text-yellow-500"></i>シーン別特徴を設定する場面の例
                        </label>
                        <div class="space-y-2 text-sm">
                            <div class="p-3 bg-yellow-50 rounded-lg border border-yellow-200">
                                <span class="font-semibold text-yellow-800">変身・変化シーン:</span>
                                <p class="text-yellow-700 mt-1">「妖精から人間の姿に変身した。羽は消え、普通の少女の姿になっている」</p>
                            </div>
                            <div class="p-3 bg-green-50 rounded-lg border border-green-200">
                                <span class="font-semibold text-green-800">衣装・装備変更:</span>
                                <p class="text-green-700 mt-1">「戦士の鎧を着ている。剣と盾を持っている」</p>
                            </div>
                            <div class="p-3 bg-red-50 rounded-lg border border-red-200">
                                <span class="font-semibold text-red-800">状態変化:</span>
                                <p class="text-red-700 mt-1">「傷だらけで疲弊した様子。服は破れ、汚れている」</p>
                            </div>
                            <div class="p-3 bg-blue-50 rounded-lg border border-blue-200">
                                <span class="font-semibold text-blue-800">成長・時間経過:</span>
                                <p class="text-blue-700 mt-1">「数年後の姿。髪が伸び、大人びた表情になっている」</p>
                            </div>
                        </div>
                    </div>
                    
                    <!-- Current traits info -->
                    <div id="trait-modal-current" class="hidden">
                        <label class="block text-sm font-semibold text-gray-700 mb-2">
                            <i class="fas fa-info-circle mr-1 text-gray-500"></i>現在の共通特徴
                        </label>
                        <div id="trait-modal-current-value" class="p-3 bg-gray-50 rounded-lg text-sm text-gray-600 italic">
                            未設定
                        </div>
                    </div>
                    </div><!-- End of trait-modal-step-edit -->
                </div>
                
                <!-- Footer -->
                <div id="trait-modal-footer" class="bg-gray-50 px-6 py-4 rounded-b-xl flex gap-3 justify-end">
                    <button 
                        id="trait-modal-back"
                        class="hidden px-6 py-2 bg-gray-200 text-gray-600 rounded-lg hover:bg-gray-300 transition-colors font-semibold mr-auto"
                    >
                        <i class="fas fa-arrow-left mr-2"></i>戻る
                    </button>
                    <button 
                        id="trait-modal-cancel"
                        class="px-6 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition-colors font-semibold"
                    >
                        キャンセル
                    </button>
                    <button 
                        id="trait-modal-save"
                        class="px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <i class="fas fa-save mr-2"></i>保存
                    </button>
                </div>
            </div>
        </div>
    </div>
    
    <!-- Phase A-3: Character Library Import Modal -->
    <div id="library-import-modal" class="hidden fixed inset-0 bg-black bg-opacity-50 z-50 overflow-y-auto">
        <div class="min-h-screen px-4 flex items-center justify-center">
            <div class="bg-white rounded-xl shadow-2xl w-full max-w-2xl my-8">
                <!-- Header -->
                <div class="bg-gradient-to-r from-green-600 to-teal-600 px-6 py-4 rounded-t-xl">
                    <h2 class="text-2xl font-bold text-white">
                        <i class="fas fa-book mr-2"></i>マイキャラクターライブラリ
                    </h2>
                </div>
                
                <!-- Content -->
                <div class="p-6 max-h-[60vh] overflow-y-auto">
                    <p class="text-sm text-gray-600 mb-4">
                        ライブラリから追加したいキャラクターを選択してください。
                    </p>
                    
                    <!-- Search -->
                    <div class="mb-4">
                        <input 
                            type="text" 
                            id="library-search"
                            placeholder="キャラクター名で検索..."
                            class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 text-sm"
                        />
                    </div>
                    
                    <!-- Character List -->
                    <div id="library-characters-list" class="space-y-3">
                        <div class="text-gray-500 text-sm">読み込み中...</div>
                    </div>
                    
                    <!-- Empty state message -->
                    <div id="library-empty-message" class="hidden text-center py-8">
                        <i class="fas fa-folder-open text-4xl text-gray-300 mb-3"></i>
                        <p class="text-gray-500">ライブラリにキャラクターがないか、すべてインポート済みです</p>
                        <p class="text-sm text-gray-400 mt-2">
                            「新規作成」ボタンで新しいキャラクターを作成できます
                        </p>
                    </div>
                </div>
                
                <!-- Footer -->
                <div class="bg-gray-50 px-6 py-4 rounded-b-xl flex gap-3 justify-between">
                    <a href="/library.html" target="_blank" class="text-sm text-green-600 hover:underline flex items-center">
                        <i class="fas fa-external-link-alt mr-1"></i>
                        ライブラリを管理
                    </a>
                    <button 
                        id="close-library-modal"
                        class="px-6 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition-colors font-semibold"
                    >
                        閉じる
                    </button>
                </div>
            </div>
        </div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
    <script>
        // Backward compatible global project id
        window.PROJECT_ID = ${projectId};
        // Keep legacy access (PROJECT_ID) for existing scripts
        const PROJECT_ID = window.PROJECT_ID;
    </script>
    <script src="/static/audio-client.js"></script>
    <script src="/static/audio-state.js"></script>
    <script src="/static/audio-ui.js"></script>
    <script src="/static/world-character-client.js"></script>
    <script src="/static/world-character-modal.js"></script>
    <script src="/static/world-character-ui.js"></script>
    <script src="/static/character-library.js"></script>
    <script src="/static/scene-edit-modal.js?v=20260120-4"></script>
    <script src="/static/character-trait-modal.js?v=20260120-2"></script>
    <!-- comic-editor v1 は凍結（Phase1.6 SSOT再構築中） -->
    <!-- <script src="/static/comic-editor.js"></script> -->
    <script src="/static/comic-editor-v2.js"></script>
    <script src="/static/project-editor.js?v=20260120"></script>
</body>
</html>
  `)
})
app.get('/login', (c) => {
  return c.html(`
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ログイン - RILARC</title>
    <link rel="icon" type="image/svg+xml" href="/static/favicon.svg">
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
</head>
<body class="bg-gradient-to-br from-blue-50 to-purple-50 min-h-screen flex items-center justify-center p-4">
    <div class="bg-white rounded-2xl shadow-xl max-w-md w-full p-8">
        <div class="text-center mb-8">
            <i class="fas fa-video text-5xl text-blue-600 mb-4"></i>
            <h1 class="text-2xl font-bold text-gray-800">RILARC</h1>
            <p class="text-gray-600 mt-2">アカウントにログイン</p>
        </div>
        
        <form id="loginForm" class="space-y-6">
            <div>
                <label class="block text-sm font-semibold text-gray-700 mb-2">
                    <i class="fas fa-envelope mr-1"></i>メールアドレス
                </label>
                <input 
                    type="email" 
                    id="email" 
                    required
                    class="w-full px-4 py-3 border-2 border-gray-200 rounded-lg focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-all"
                    placeholder="your@email.com"
                >
            </div>
            
            <div>
                <label class="block text-sm font-semibold text-gray-700 mb-2">
                    <i class="fas fa-lock mr-1"></i>パスワード
                </label>
                <input 
                    type="password" 
                    id="password" 
                    required
                    class="w-full px-4 py-3 border-2 border-gray-200 rounded-lg focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-all"
                    placeholder="••••••••"
                >
            </div>
            
            <div id="errorMessage" class="hidden p-4 bg-red-50 border-l-4 border-red-500 text-red-700 rounded">
                <i class="fas fa-exclamation-circle mr-2"></i>
                <span id="errorText"></span>
            </div>
            
            <button 
                type="submit"
                class="w-full py-3 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center gap-2"
            >
                <i class="fas fa-sign-in-alt"></i>
                ログイン
            </button>
        </form>
        
        <div class="mt-6 text-center space-y-3">
            <a href="/forgot-password" class="text-blue-600 hover:underline text-sm">
                <i class="fas fa-key mr-1"></i>パスワードをお忘れですか？
            </a>
            <div class="text-gray-500 text-sm">
                アカウントをお持ちでない方は
                <a href="/signup" class="text-blue-600 hover:underline">新規登録</a>
            </div>
        </div>
    </div>
    
    <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
    <script>
        document.getElementById('loginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const email = document.getElementById('email').value;
            const password = document.getElementById('password').value;
            const errorDiv = document.getElementById('errorMessage');
            const errorText = document.getElementById('errorText');
            
            errorDiv.classList.add('hidden');
            
            try {
                const response = await axios.post('/api/auth/login', { email, password });
                if (response.data.success) {
                    window.location.href = '/';
                }
            } catch (error) {
                errorDiv.classList.remove('hidden');
                const message = error.response?.data?.error?.message || 'ログインに失敗しました';
                errorText.textContent = message;
            }
        });
    </script>
</body>
</html>
  `)
})

// Register page
app.get('/register', (c) => {
  return c.html(`
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>新規登録 - RILARC</title>
    <link rel="icon" type="image/svg+xml" href="/static/favicon.svg">
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
</head>
<body class="bg-gradient-to-br from-blue-50 to-purple-50 min-h-screen flex items-center justify-center p-4">
    <div class="bg-white rounded-2xl shadow-xl max-w-md w-full p-8">
        <div class="text-center mb-8">
            <i class="fas fa-video text-5xl text-blue-600 mb-4"></i>
            <h1 class="text-2xl font-bold text-gray-800">RILARC</h1>
            <p class="text-gray-600 mt-2">新規アカウント登録</p>
        </div>
        
        <form id="registerForm" class="space-y-5">
            <div>
                <label class="block text-sm font-semibold text-gray-700 mb-2">
                    <i class="fas fa-user mr-1"></i>お名前 <span class="text-red-500">*</span>
                </label>
                <input 
                    type="text" 
                    id="name" 
                    required
                    class="w-full px-4 py-3 border-2 border-gray-200 rounded-lg focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-all"
                    placeholder="山田 太郎"
                >
            </div>
            
            <div>
                <label class="block text-sm font-semibold text-gray-700 mb-2">
                    <i class="fas fa-envelope mr-1"></i>メールアドレス <span class="text-red-500">*</span>
                </label>
                <input 
                    type="email" 
                    id="email" 
                    required
                    class="w-full px-4 py-3 border-2 border-gray-200 rounded-lg focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-all"
                    placeholder="your@email.com"
                >
            </div>
            
            <div>
                <label class="block text-sm font-semibold text-gray-700 mb-2">
                    <i class="fas fa-lock mr-1"></i>パスワード <span class="text-red-500">*</span>
                </label>
                <input 
                    type="password" 
                    id="password" 
                    required
                    minlength="8"
                    class="w-full px-4 py-3 border-2 border-gray-200 rounded-lg focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-all"
                    placeholder="8文字以上"
                >
            </div>
            
            <div>
                <label class="block text-sm font-semibold text-gray-700 mb-2">
                    <i class="fas fa-building mr-1"></i>会社名（任意）
                </label>
                <input 
                    type="text" 
                    id="company"
                    class="w-full px-4 py-3 border-2 border-gray-200 rounded-lg focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-all"
                    placeholder="株式会社〇〇"
                >
            </div>
            
            <div id="errorMessage" class="hidden p-4 bg-red-50 border-l-4 border-red-500 text-red-700 rounded">
                <i class="fas fa-exclamation-circle mr-2"></i>
                <span id="errorText"></span>
            </div>
            
            <div id="successMessage" class="hidden p-4 bg-green-50 border-l-4 border-green-500 text-green-700 rounded">
                <i class="fas fa-check-circle mr-2"></i>
                <span id="successText"></span>
            </div>
            
            <button 
                type="submit"
                class="w-full py-3 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center gap-2"
            >
                <i class="fas fa-user-plus"></i>
                登録する
            </button>
        </form>
        
        <div class="mt-6 text-center">
            <span class="text-gray-500 text-sm">
                すでにアカウントをお持ちの方は
                <a href="/login" class="text-blue-600 hover:underline">ログイン</a>
            </span>
        </div>
    </div>
    
    <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
    <script>
        document.getElementById('registerForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const name = document.getElementById('name').value;
            const email = document.getElementById('email').value;
            const password = document.getElementById('password').value;
            const company = document.getElementById('company').value;
            
            const errorDiv = document.getElementById('errorMessage');
            const successDiv = document.getElementById('successMessage');
            const errorText = document.getElementById('errorText');
            const successText = document.getElementById('successText');
            
            errorDiv.classList.add('hidden');
            successDiv.classList.add('hidden');
            
            try {
                const response = await axios.post('/api/auth/register', { name, email, password, company });
                if (response.data.success) {
                    successDiv.classList.remove('hidden');
                    successText.textContent = response.data.message;
                    document.getElementById('registerForm').reset();
                }
            } catch (error) {
                errorDiv.classList.remove('hidden');
                const message = error.response?.data?.error?.message || '登録に失敗しました';
                errorText.textContent = message;
            }
        });
    </script>
</body>
</html>
  `)
})

// Forgot password page
app.get('/forgot-password', (c) => {
  return c.html(`
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>パスワードリセット - RILARC</title>
    <link rel="icon" type="image/svg+xml" href="/static/favicon.svg">
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
</head>
<body class="bg-gradient-to-br from-blue-50 to-purple-50 min-h-screen flex items-center justify-center p-4">
    <div class="bg-white rounded-2xl shadow-xl max-w-md w-full p-8">
        <div class="text-center mb-8">
            <i class="fas fa-key text-5xl text-blue-600 mb-4"></i>
            <h1 class="text-2xl font-bold text-gray-800">パスワードリセット</h1>
            <p class="text-gray-600 mt-2">登録メールアドレスを入力してください</p>
        </div>
        
        <form id="forgotForm" class="space-y-6">
            <div>
                <label class="block text-sm font-semibold text-gray-700 mb-2">
                    <i class="fas fa-envelope mr-1"></i>メールアドレス
                </label>
                <input 
                    type="email" 
                    id="email" 
                    required
                    class="w-full px-4 py-3 border-2 border-gray-200 rounded-lg focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-all"
                    placeholder="your@email.com"
                >
            </div>
            
            <div id="successMessage" class="hidden p-4 bg-green-50 border-l-4 border-green-500 text-green-700 rounded">
                <i class="fas fa-check-circle mr-2"></i>
                リセットリンクを送信しました。メールをご確認ください。
            </div>
            
            <button 
                type="submit"
                class="w-full py-3 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center gap-2"
            >
                <i class="fas fa-paper-plane"></i>
                リセットリンクを送信
            </button>
        </form>
        
        <div class="mt-6 text-center">
            <a href="/login" class="text-blue-600 hover:underline text-sm">
                <i class="fas fa-arrow-left mr-1"></i>ログインに戻る
            </a>
        </div>
    </div>
    
    <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
    <script>
        document.getElementById('forgotForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const email = document.getElementById('email').value;
            const successDiv = document.getElementById('successMessage');
            
            try {
                await axios.post('/api/auth/forgot-password', { email });
                successDiv.classList.remove('hidden');
            } catch (error) {
                // Always show success to prevent email enumeration
                successDiv.classList.remove('hidden');
            }
        });
    </script>
</body>
</html>
  `)
})

// Reset password page
app.get('/reset-password', (c) => {
  return c.html(`
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>新しいパスワード設定 - RILARC</title>
    <link rel="icon" type="image/svg+xml" href="/static/favicon.svg">
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
</head>
<body class="bg-gradient-to-br from-blue-50 to-purple-50 min-h-screen flex items-center justify-center p-4">
    <div class="bg-white rounded-2xl shadow-xl max-w-md w-full p-8">
        <div class="text-center mb-8">
            <i class="fas fa-lock text-5xl text-blue-600 mb-4"></i>
            <h1 class="text-2xl font-bold text-gray-800">新しいパスワード設定</h1>
            <p class="text-gray-600 mt-2">新しいパスワードを入力してください</p>
        </div>
        
        <form id="resetForm" class="space-y-6">
            <div>
                <label class="block text-sm font-semibold text-gray-700 mb-2">
                    <i class="fas fa-lock mr-1"></i>新しいパスワード
                </label>
                <input 
                    type="password" 
                    id="password" 
                    required
                    minlength="8"
                    class="w-full px-4 py-3 border-2 border-gray-200 rounded-lg focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-all"
                    placeholder="8文字以上"
                >
            </div>
            
            <div>
                <label class="block text-sm font-semibold text-gray-700 mb-2">
                    <i class="fas fa-lock mr-1"></i>パスワード確認
                </label>
                <input 
                    type="password" 
                    id="passwordConfirm" 
                    required
                    minlength="8"
                    class="w-full px-4 py-3 border-2 border-gray-200 rounded-lg focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-all"
                    placeholder="もう一度入力"
                >
            </div>
            
            <div id="errorMessage" class="hidden p-4 bg-red-50 border-l-4 border-red-500 text-red-700 rounded">
                <i class="fas fa-exclamation-circle mr-2"></i>
                <span id="errorText"></span>
            </div>
            
            <div id="successMessage" class="hidden p-4 bg-green-50 border-l-4 border-green-500 text-green-700 rounded">
                <i class="fas fa-check-circle mr-2"></i>
                パスワードを更新しました。<a href="/login" class="underline">ログイン</a>してください。
            </div>
            
            <button 
                type="submit"
                class="w-full py-3 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center gap-2"
            >
                <i class="fas fa-save"></i>
                パスワードを更新
            </button>
        </form>
    </div>
    
    <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
    <script>
        document.getElementById('resetForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const password = document.getElementById('password').value;
            const passwordConfirm = document.getElementById('passwordConfirm').value;
            const errorDiv = document.getElementById('errorMessage');
            const successDiv = document.getElementById('successMessage');
            const errorText = document.getElementById('errorText');
            
            errorDiv.classList.add('hidden');
            successDiv.classList.add('hidden');
            
            if (password !== passwordConfirm) {
                errorDiv.classList.remove('hidden');
                errorText.textContent = 'パスワードが一致しません';
                return;
            }
            
            const urlParams = new URLSearchParams(window.location.search);
            const token = urlParams.get('token');
            
            if (!token) {
                errorDiv.classList.remove('hidden');
                errorText.textContent = '無効なリセットリンクです';
                return;
            }
            
            try {
                const response = await axios.post('/api/auth/reset-password', { token, password });
                if (response.data.success) {
                    successDiv.classList.remove('hidden');
                    document.getElementById('resetForm').reset();
                }
            } catch (error) {
                errorDiv.classList.remove('hidden');
                const message = error.response?.data?.error?.message || 'パスワードリセットに失敗しました';
                errorText.textContent = message;
            }
        });
    </script>
</body>
</html>
  `)
})

// Admin route
app.get('/admin', (c) => {
  return c.html(adminHtml)
})

// Settings route
app.get('/settings', (c) => {
  return c.html(settingsHtml)
})

// Signup route
app.get('/signup', (c) => {
  return c.html(`
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>新規登録 - RILARC Scenario Generator</title>
    <link rel="icon" type="image/svg+xml" href="/static/favicon.svg">
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
</head>
<body class="bg-gradient-to-br from-green-50 to-teal-100 min-h-screen flex items-center justify-center p-4">
    <div class="bg-white rounded-2xl shadow-xl w-full max-w-md p-8">
        <div class="text-center mb-8">
            <h1 class="text-2xl font-bold text-gray-800">
                <i class="fas fa-film text-green-600 mr-2"></i>
                RILARC
            </h1>
            <p class="text-gray-600 mt-2">新規アカウント登録</p>
        </div>
        
        <form id="signupForm" class="space-y-5">
            <div>
                <label class="block text-sm font-semibold text-gray-700 mb-2">
                    お名前 <span class="text-red-500">*</span>
                </label>
                <input 
                    type="text" 
                    id="name" 
                    required
                    class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
                    placeholder="山田 太郎"
                />
            </div>
            
            <div>
                <label class="block text-sm font-semibold text-gray-700 mb-2">
                    メールアドレス <span class="text-red-500">*</span>
                </label>
                <input 
                    type="email" 
                    id="email" 
                    required
                    class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
                    placeholder="your@email.com"
                />
            </div>
            
            <div>
                <label class="block text-sm font-semibold text-gray-700 mb-2">
                    パスワード <span class="text-red-500">*</span>
                </label>
                <input 
                    type="password" 
                    id="password" 
                    required
                    minlength="8"
                    class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
                    placeholder="8文字以上"
                />
            </div>
            
            <div>
                <label class="block text-sm font-semibold text-gray-700 mb-2">
                    会社名（任意）
                </label>
                <input 
                    type="text" 
                    id="company"
                    class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
                    placeholder="株式会社〇〇"
                />
            </div>
            
            <div>
                <label class="block text-sm font-semibold text-gray-700 mb-2">
                    電話番号（任意）
                </label>
                <input 
                    type="tel" 
                    id="phone"
                    class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
                    placeholder="090-1234-5678"
                />
            </div>
            
            <div id="error" class="hidden text-red-600 text-sm bg-red-50 p-3 rounded-lg"></div>
            <div id="success" class="hidden text-green-600 text-sm bg-green-50 p-3 rounded-lg"></div>
            
            <button 
                type="submit"
                class="w-full py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-semibold"
            >
                <i class="fas fa-user-plus mr-2"></i>
                登録する
            </button>
        </form>
        
        <div class="mt-6 text-center">
            <p class="text-gray-600 text-sm">
                すでにアカウントをお持ちの方は
                <a href="/login" class="text-green-600 hover:underline font-semibold">ログイン</a>
            </p>
        </div>
    </div>
    
    <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
    <script>
        document.getElementById('signupForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const name = document.getElementById('name').value;
            const email = document.getElementById('email').value;
            const password = document.getElementById('password').value;
            const company = document.getElementById('company').value || null;
            const phone = document.getElementById('phone').value || null;
            const errorEl = document.getElementById('error');
            const successEl = document.getElementById('success');
            
            errorEl.classList.add('hidden');
            successEl.classList.add('hidden');
            
            try {
                const res = await axios.post('/api/auth/signup', { name, email, password, company, phone });
                if (res.data.success) {
                    successEl.innerHTML = \`
                        <i class="fas fa-check-circle mr-2"></i>
                        \${res.data.message}<br>
                        <span class="text-xs mt-1 block">管理者の承認後、ログインできるようになります。</span>
                    \`;
                    successEl.classList.remove('hidden');
                    document.getElementById('signupForm').reset();
                }
            } catch (err) {
                const msg = err.response?.data?.error?.message || '登録に失敗しました';
                errorEl.textContent = msg;
                errorEl.classList.remove('hidden');
            }
        });
    </script>
</body>
</html>
  `)
})

export default app
