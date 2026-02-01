import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'
import type { Bindings } from './types/bindings'

// Asset version for cache busting
// Priority: 1) env.ASSET_VERSION (set by CI/CD), 2) __BUILD_VERSION__ (set at build time), 3) fallback
// This ensures fresh assets are loaded after each deployment

// __BUILD_VERSION__ is replaced by Vite's define at build time with git hash or timestamp
declare const __BUILD_VERSION__: string;

/**
 * Get asset version for cache busting
 * @param env - Cloudflare environment bindings
 * @returns version string for ?v= query parameter
 */
function getAssetVersion(env?: Bindings): string {
  // 1. Environment variable (highest priority - set by CI/CD)
  if (env?.ASSET_VERSION) {
    return env.ASSET_VERSION;
  }
  // 2. Build version (replaced during build with git hash)
  try {
    if (typeof __BUILD_VERSION__ !== 'undefined' && __BUILD_VERSION__) {
      return __BUILD_VERSION__;
    }
  } catch {
    // __BUILD_VERSION__ not defined (development mode)
  }
  // 3. Fallback (development)
  return 'dev';
}
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
import utterances from './routes/utterances' // R1.5: Scene utterances API
import sceneBalloons from './routes/scene-balloons' // A案 baked: Balloon image management
import projectAudioTracks from './routes/project-audio-tracks' // R3-A: Project BGM
import { sceneAudioCues } from './routes/scene-audio-cues' // R3-B: Scene SFX
import { audioLibrary } from './routes/audio-library' // P1: User Audio Library
import { sceneAudioAssignments } from './routes/scene-audio-assignments' // P2: Scene Audio Assignments
import webhooks from './routes/webhooks' // AWS Orchestrator webhooks
import patches from './routes/patches' // R4: SSOT Patch API (chat edit)
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
app.route('/api', utterances) // R1.5: For /api/scenes/:sceneId/utterances, /api/utterances/:id
app.route('/api/scene-balloons', sceneBalloons) // A案 baked: For /api/scene-balloons/:id, /api/scene-balloons/:id/upload-image
app.route('/api', projectAudioTracks) // R3-A: For /api/projects/:projectId/audio-tracks
app.route('/api', sceneAudioCues) // R3-B: For /api/scenes/:sceneId/audio-cues
app.route('/api', audioLibrary) // P1: For /api/audio-library
app.route('/api/scenes', sceneAudioAssignments) // P2: For /api/scenes/:sceneId/audio-assignments - MUST be before generic /api/scenes/:id
app.route('/api', patches) // R4: For /api/projects/:projectId/patches/*
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

// Webhooks (explicit route for AWS Orchestrator callbacks)
app.route('/api/webhooks', webhooks) // For /api/webhooks/video-build

// Settings routes (API key management)
app.route('/api', settings) // For /api/settings/api-keys/*

// Authentication routes
app.route('/api', auth) // For /api/auth/*
app.route('/api/admin', admin) // For /api/admin/* (superadmin only)

// Root route - serve HTML
// Root route - with authentication check
app.get('/', (c) => {
  const ASSET_VERSION = getAssetVersion(c.env)
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
        // SSOT: Configure axios to always send credentials (cookies) for authentication
        axios.defaults.withCredentials = true;
        
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
    <script src="/static/app.js?v=${ASSET_VERSION}"></script>
</body>
</html>
  `)
})

// Project Editor route

app.get('/projects/:id', (c) => {
  const projectId = c.req.param('id')
  const ASSET_VERSION = getAssetVersion(c.env)
  
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

        <!-- Progress Bar - Prominent workflow indicator -->
        <div id="projectProgressBar" class="bg-gradient-to-r from-blue-50 to-purple-50 rounded-xl shadow-lg mb-4 p-6 border-2 border-blue-200">
            <div class="flex items-center justify-between mb-3">
                <span class="text-lg font-bold text-gray-800">
                    <i class="fas fa-tasks mr-2 text-blue-600"></i>制作進捗
                </span>
                <span id="progressPercent" class="text-2xl font-bold text-blue-600">0%</span>
            </div>
            <div class="w-full bg-gray-200 rounded-full h-4 mb-4 shadow-inner">
                <div id="progressBarFill" class="bg-gradient-to-r from-blue-500 via-purple-500 to-pink-500 h-4 rounded-full transition-all duration-500 shadow-md" style="width: 0%"></div>
            </div>
            <div class="flex justify-between text-xs mb-4">
                <div id="step1" class="flex flex-col items-center flex-1">
                    <div class="w-10 h-10 rounded-full bg-gray-300 flex items-center justify-center mb-1 step-circle shadow-md transition-all duration-300">
                        <i class="fas fa-upload text-white"></i>
                    </div>
                    <span class="text-gray-500 step-label font-medium">入力</span>
                </div>
                <div id="step2" class="flex flex-col items-center flex-1">
                    <div class="w-10 h-10 rounded-full bg-gray-300 flex items-center justify-center mb-1 step-circle shadow-md transition-all duration-300">
                        <i class="fas fa-cut text-white"></i>
                    </div>
                    <span class="text-gray-500 step-label font-medium">分割</span>
                </div>
                <div id="step3" class="flex flex-col items-center flex-1">
                    <div class="w-10 h-10 rounded-full bg-gray-300 flex items-center justify-center mb-1 step-circle shadow-md transition-all duration-300">
                        <i class="fas fa-image text-white"></i>
                    </div>
                    <span class="text-gray-500 step-label font-medium">画像</span>
                </div>
                <div id="step4" class="flex flex-col items-center flex-1">
                    <div class="w-10 h-10 rounded-full bg-gray-300 flex items-center justify-center mb-1 step-circle shadow-md transition-all duration-300">
                        <i class="fas fa-film text-white"></i>
                    </div>
                    <span class="text-gray-500 step-label font-medium">動画</span>
                </div>
                <div id="step5" class="flex flex-col items-center flex-1">
                    <div class="w-10 h-10 rounded-full bg-gray-300 flex items-center justify-center mb-1 step-circle shadow-md transition-all duration-300">
                        <i class="fas fa-check text-white"></i>
                    </div>
                    <span class="text-gray-500 step-label font-medium">完了</span>
                </div>
            </div>
            <div id="progressMessage" class="text-center text-base text-gray-700 font-semibold bg-white rounded-lg py-3 px-4 shadow-sm"></div>
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
                    <div class="flex items-center justify-between flex-wrap gap-4">
                        <p class="text-sm text-gray-700">
                            <i class="fas fa-check-circle text-green-600 mr-2"></i>
                            入力が完了しました。次は<strong>Scene Split</strong>タブでシーン分割を実行してください。
                        </p>
                        <button 
                            onclick="switchTab('sceneSplit')"
                            class="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-sm font-semibold touch-manipulation"
                        >
                            <i class="fas fa-cut mr-2"></i>シーン分割へ進む
                        </button>
                    </div>
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
                
                <!-- Format Section with Mode Selection -->
                <div id="formatSection" class="mb-6 p-4 bg-purple-50 rounded-lg border-l-4 border-purple-600 hidden">
                    <h3 class="font-semibold text-gray-800 mb-3"><i class="fas fa-cut mr-2"></i>シーン分割設定</h3>
                    
                    <!-- Split Mode Selection -->
                    <div class="mb-4">
                        <label class="text-sm font-medium text-gray-700 mb-2 block">分割モード</label>
                        <div class="space-y-2">
                            <label class="flex items-start gap-3 p-3 bg-white rounded-lg border border-gray-200 cursor-pointer hover:border-purple-400 transition-colors">
                                <input type="radio" name="splitMode" value="preserve" class="mt-1" checked>
                                <div>
                                    <div class="font-medium text-gray-800">原文維持（台本モード）</div>
                                    <div class="text-xs text-gray-500">
                                        原文を一切改変しません。空行（段落）で分割し、各段落をそのまま1シーンにします。<br>
                                        <span class="text-purple-600">画像プロンプトのみAI生成</span>
                                    </div>
                                </div>
                            </label>
                            <label class="flex items-start gap-3 p-3 bg-white rounded-lg border border-gray-200 cursor-pointer hover:border-purple-400 transition-colors">
                                <input type="radio" name="splitMode" value="ai" class="mt-1">
                                <div>
                                    <div class="font-medium text-gray-800">AI整理モード</div>
                                    <div class="text-xs text-gray-500">
                                        AIが意図を読み取り、適切に分割・整理します。<br>
                                        <span class="text-amber-600">⚠️ 文章が要約・再構成される場合があります</span>
                                    </div>
                                </div>
                            </label>
                        </div>
                    </div>
                    
                    <!-- Target Scene Count (conditionally shown) -->
                    <div id="targetSceneCountSection" class="mb-4">
                        <label class="text-sm font-medium text-gray-700 mb-2 block">
                            目標シーン数
                            <span class="text-xs text-gray-500 ml-2">（空欄=段落数に従う）</span>
                        </label>
                        <div class="flex items-center gap-3">
                            <input 
                                type="number" 
                                id="targetSceneCount" 
                                min="1" 
                                max="100" 
                                placeholder="自動"
                                class="w-24 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                            >
                            <span class="text-sm text-gray-600">シーン</span>
                            <span id="paragraphCountInfo" class="text-sm text-gray-500 ml-2"></span>
                        </div>
                        <p class="text-xs text-gray-500 mt-1">
                            <i class="fas fa-info-circle mr-1"></i>
                            <span id="splitModeHint">原文維持モード: 段落数より多い場合は文境界で分割、少ない場合は結合（省略なし）</span>
                        </p>
                    </div>
                    
                    <!-- Execute Button -->
                    <div class="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 pt-3 border-t border-purple-200">
                        <div class="text-sm text-red-600 bg-red-50 px-3 py-2 rounded">
                            <i class="fas fa-exclamation-triangle mr-1"></i>
                            <strong>注意:</strong> 実行すると既存のシーン・音声・画像・バブル・SFX/BGMが削除されます
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
                            <!-- A/B/C Legend -->
                            <div class="flex flex-wrap gap-3 text-xs mb-3 p-2 bg-white rounded border border-indigo-100">
                                <div class="flex items-center gap-1">
                                    <span class="inline-flex items-center justify-center w-5 h-5 rounded text-white font-bold bg-gray-500">A</span>
                                    <span class="text-gray-600">キャラ登録（Stylesで設定）</span>
                                </div>
                                <div class="flex items-center gap-1">
                                    <span class="inline-flex items-center justify-center w-5 h-5 rounded text-white font-bold bg-purple-500">B</span>
                                    <span class="text-purple-600">物語共通（Stylesで設定）</span>
                                </div>
                                <div class="flex items-center gap-1">
                                    <span class="inline-flex items-center justify-center w-5 h-5 rounded text-white font-bold bg-yellow-500">C</span>
                                    <span class="text-yellow-700">シーン別（各シーンで設定）</span>
                                </div>
                            </div>
                            <p class="text-xs text-gray-600 mb-2">
                                <i class="fas fa-info-circle mr-1"></i>
                                優先度: <strong>C > B > A</strong>（シーン別があれば最優先）
                                <br>
                                <i class="fas fa-exclamation-triangle mr-1 text-orange-500"></i>
                                見た目のみ記載。セリフ・感情・行動は入れないでください。
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
                
                <!-- Video Build Wizard (preflight-based) -->
                <div id="builderWizard" class="mb-4 p-4 bg-white rounded-xl border-2 border-indigo-200 shadow-sm">
                    <div class="flex items-center justify-between gap-3">
                        <div class="flex items-center gap-2">
                            <i class="fas fa-route text-indigo-600 text-lg"></i>
                            <div>
                                <div class="font-bold text-gray-800">動画生成の準備状況</div>
                                <div class="text-xs text-gray-500">素材・音声・バブルの状態を確認</div>
                            </div>
                        </div>
                        <div class="flex items-center gap-2">
                            <button onclick="refreshBuilderWizard()" class="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs hover:bg-indigo-700 transition-colors">
                                <i class="fas fa-sync-alt mr-1"></i>更新
                            </button>
                        </div>
                    </div>

                    <div id="builderWizardSteps" class="mt-3 grid grid-cols-1 md:grid-cols-4 gap-2">
                        <div class="text-gray-400 text-sm p-2">読み込み中...</div>
                    </div>
                    <div id="builderWizardTips" class="mt-3 text-xs text-gray-600"></div>
                </div>

                <!-- Top Action Bar (Phase F-5: Improved workflow order) -->
                <div class="mb-6 p-4 bg-gray-50 rounded-lg border-2 border-gray-200">
                    <!-- Workflow Guide (compact) -->
                    <div class="mb-4 p-3 bg-blue-50 rounded-lg border border-blue-200">
                        <p class="text-sm text-blue-800">
                            <i class="fas fa-info-circle mr-2"></i>
                            <strong>素材準備:</strong>
                            ① キャラ割り当て → ② スタイル設定 → ③ 画像生成 → <strong class="text-purple-700">④ 動画ビルド</strong>
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
                    
                    <!-- Step 3.5: Output Preset Selection -->
                    <div class="mb-4 pb-4 border-b border-gray-300">
                        <label class="block text-sm font-semibold text-gray-700 mb-2">
                            <span class="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-600 text-white text-xs mr-2">⚙</span>
                            <i class="fas fa-tv mr-1 text-indigo-600"></i>配信先プリセット
                        </label>
                        <div class="flex flex-col sm:flex-row gap-2 ml-7">
                            <select 
                                id="outputPresetSelector"
                                onchange="saveOutputPreset(this.value)"
                                class="flex-1 px-3 py-2 border-2 border-gray-300 rounded-lg focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 text-sm"
                            >
                                <option value="yt_long">📺 YouTube長尺 (16:9 横型)</option>
                                <option value="short_vertical">📱 縦型ショート汎用 (9:16)</option>
                                <option value="yt_shorts">🎬 YouTube Shorts (9:16)</option>
                                <option value="reels">📸 Instagram Reels (9:16)</option>
                                <option value="tiktok">🎵 TikTok (9:16)</option>
                            </select>
                        </div>
                        <p class="text-xs text-gray-500 mt-1 ml-7">配信先に合わせてテロップ・余白・安全領域が自動調整されます</p>
                        <div id="outputPresetPreview" class="mt-2 ml-7 text-xs text-indigo-600 hidden">
                            <i class="fas fa-info-circle mr-1"></i>
                            <span id="outputPresetPreviewText"></span>
                        </div>
                    </div>
                    
                    <!-- Step 4: BGM Settings (R3-A) -->
                    <div class="mb-4 pb-4 border-b border-gray-300">
                        <label class="block text-sm font-semibold text-gray-700 mb-2">
                            <span class="inline-flex items-center justify-center w-5 h-5 rounded-full bg-yellow-600 text-white text-xs mr-2">4</span>
                            <i class="fas fa-music mr-1 text-yellow-600"></i>BGM設定
                        </label>
                        
                        <!-- BGM Status Card -->
                        <div id="bgmStatusCard" class="ml-7 p-4 bg-gray-50 rounded-lg border-2 border-gray-200">
                            <!-- No BGM State -->
                            <div id="bgmEmptyState">
                                <div class="flex items-center gap-3 text-gray-500">
                                    <i class="fas fa-volume-mute text-2xl"></i>
                                    <div>
                                        <p class="font-medium">BGM未設定</p>
                                        <p class="text-xs">ボイスなしのシーンも音ありで生成できます</p>
                                    </div>
                                </div>
                                <div class="mt-3 flex gap-2 flex-wrap">
                                    <button
                                        onclick="openProjectBgmLibrary('system')"
                                        class="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors font-semibold inline-flex items-center gap-2"
                                    >
                                        <i class="fas fa-database"></i>
                                        システムBGM
                                    </button>
                                    <button
                                        onclick="openProjectBgmLibrary('user')"
                                        class="px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 transition-colors font-semibold inline-flex items-center gap-2"
                                    >
                                        <i class="fas fa-folder"></i>
                                        マイBGM
                                    </button>
                                    <label class="cursor-pointer px-4 py-2 bg-yellow-500 text-white rounded-lg hover:bg-yellow-600 transition-colors font-semibold inline-flex items-center gap-2">
                                        <i class="fas fa-upload"></i>
                                        アップロード
                                        <input 
                                            type="file" 
                                            id="bgmFileInput"
                                            accept="audio/*"
                                            class="hidden"
                                            onchange="handleBgmUpload(event)"
                                        />
                                    </label>
                                </div>
                            </div>
                            
                            <!-- BGM Active State -->
                            <div id="bgmActiveState" class="hidden">
                                <div class="flex items-center gap-3 mb-3">
                                    <i class="fas fa-music text-2xl text-yellow-600"></i>
                                    <div class="flex-1">
                                        <p class="font-medium text-gray-800">BGM設定済み <span class="text-green-600">✓</span></p>
                                        <p class="text-xs text-gray-500" id="bgmFileName">-</p>
                                    </div>
                                    <button 
                                        onclick="removeBgm()"
                                        class="p-2 text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                                        title="BGMを削除"
                                    >
                                        <i class="fas fa-trash"></i>
                                    </button>
                                </div>
                                
                                <!-- Audio Preview -->
                                <audio id="bgmPreviewPlayer" controls class="w-full mb-3 h-10"></audio>
                                
                                <!-- Volume Control -->
                                <div class="flex items-center gap-3">
                                    <label class="text-sm text-gray-600 flex items-center gap-1">
                                        <i class="fas fa-volume-up"></i>
                                        音量:
                                    </label>
                                    <input 
                                        type="range" 
                                        id="bgmVolumeSlider"
                                        min="0" 
                                        max="100" 
                                        value="25"
                                        class="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-yellow-600"
                                        onchange="updateBgmVolume(this.value)"
                                    />
                                    <span id="bgmVolumeLabel" class="text-sm text-gray-700 w-10">25%</span>
                                </div>
                                
                                <!-- Loop Toggle -->
                                <div class="flex items-center gap-3 mt-3">
                                    <label class="flex items-center gap-2 cursor-pointer">
                                        <input 
                                            type="checkbox" 
                                            id="bgmLoopToggle"
                                            checked
                                            onchange="updateBgmLoop(this.checked)"
                                            class="w-4 h-4 text-yellow-600 rounded focus:ring-yellow-500"
                                        />
                                        <span class="text-sm text-gray-700">ループ再生</span>
                                    </label>
                                </div>
                            </div>
                            
                            <!-- Upload Progress State -->
                            <div id="bgmUploadingState" class="hidden">
                                <div class="flex items-center gap-3">
                                    <i class="fas fa-spinner fa-spin text-2xl text-yellow-600"></i>
                                    <div>
                                        <p class="font-medium text-gray-800">アップロード中...</p>
                                        <div class="w-48 h-2 bg-gray-200 rounded-full mt-1">
                                            <div id="bgmUploadProgress" class="h-full bg-yellow-500 rounded-full transition-all" style="width: 0%"></div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <p class="text-xs text-gray-500 mt-2 ml-7">
                            <i class="fas fa-info-circle mr-1"></i>
                            BGMは動画全体に適用されます。ボイス再生時は自動で音量が下がります（ダッキング）
                        </p>
                    </div>
                    
                    <div class="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                        <!-- Status Summary -->
                        <div id="builderStatusSummary" class="text-sm text-gray-600">
                            <!-- Will be populated by JS -->
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
                                <span class="text-gray-500">/ 60</span>
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

                <!-- Video Build Config Card (出力設定) -->
                <div id="videoBuildConfigCard" class="mb-6 bg-white rounded-xl shadow border border-gray-200">
                    <div class="p-4 border-b flex items-center justify-between">
                        <h3 class="text-lg font-bold text-gray-800 flex items-center">
                            <i class="fas fa-sliders-h mr-2 text-indigo-600"></i>出力設定
                        </h3>
                        <div class="text-xs text-gray-500">
                            ※ 最終的な動画の出力ルールをここで決めます
                        </div>
                    </div>

                    <div class="p-6 space-y-5">
                        <!-- 配信先プリセット -->
                        <div>
                            <label class="block text-sm font-semibold text-gray-700 mb-2">
                                <i class="fas fa-tv mr-1 text-indigo-600"></i>配信先プリセット
                            </label>
                            <select id="vbPresetSelector"
                                class="w-full px-3 py-2 border-2 border-gray-300 rounded-lg focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 text-sm">
                                <option value="yt_long">📺 YouTube 長尺（16:9）</option>
                                <option value="short_vertical" disabled>📱 縦型ショート（9:16）※準備中</option>
                                <option value="yt_shorts" disabled>🎬 YouTube Shorts（9:16）※準備中</option>
                                <option value="reels" disabled>📸 Instagram Reels（9:16）※準備中</option>
                                <option value="tiktok" disabled>🎵 TikTok（9:16）※準備中</option>
                            </select>
                            <p class="text-xs text-gray-500 mt-1">
                                現状は「YouTube 長尺（16:9）」前提で運用（縦型は制作ボード側の表示仕様が未対応のため）
                            </p>
                        </div>

                        <!-- 字幕・BGM -->
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <!-- 字幕 -->
                            <div class="p-4 bg-gray-50 rounded-lg border">
                                <div class="flex items-center justify-between">
                                    <label class="text-sm font-semibold text-gray-700 flex items-center gap-2">
                                        <i class="fas fa-closed-captioning text-indigo-600"></i>字幕
                                    </label>
                                    <label class="inline-flex items-center gap-2 cursor-pointer">
                                        <input id="vbCaptionsToggle" type="checkbox" class="w-4 h-4 text-indigo-600 rounded" checked />
                                        <span class="text-sm text-gray-700">表示する</span>
                                    </label>
                                </div>
                                <div class="mt-3">
                                    <label class="text-xs text-gray-600">字幕位置</label>
                                    <select id="vbCaptionsPosition"
                                        class="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
                                        <option value="bottom">下</option>
                                        <option value="center_bottom">中央下</option>
                                        <option value="top_center">上</option>
                                    </select>
                                </div>
                            </div>

                            <!-- BGM -->
                            <div class="p-4 bg-gray-50 rounded-lg border">
                                <div class="flex items-center justify-between">
                                    <label class="text-sm font-semibold text-gray-700 flex items-center gap-2">
                                        <i class="fas fa-music text-indigo-600"></i>BGM
                                    </label>
                                    <label class="inline-flex items-center gap-2 cursor-pointer">
                                        <input id="vbBgmToggle" type="checkbox" class="w-4 h-4 text-indigo-600 rounded" />
                                        <span class="text-sm text-gray-700">入れる</span>
                                    </label>
                                </div>
                                <div class="mt-3">
                                    <label class="text-xs text-gray-600">BGM音量</label>
                                    <div class="flex items-center gap-3 mt-1">
                                        <input id="vbBgmVolume" type="range" min="0" max="100" value="25"
                                            class="flex-1 accent-indigo-600" oninput="updateBgmVolumeLabel()" />
                                        <span id="vbBgmVolumeLabel" class="text-xs text-gray-700 w-10">25%</span>
                                    </div>
                                    <p class="text-xs text-gray-500 mt-1">※ BGMファイル自体の管理はBGM設定で行います</p>
                                </div>
                            </div>
                        </div>

                        <!-- テロップ（PR-5-3a）※字幕とは別 -->
                        <div class="p-4 bg-amber-50/50 rounded-lg border border-amber-200">
                            <div class="flex items-center justify-between">
                                <label class="text-sm font-semibold text-gray-700 flex items-center gap-2">
                                    <i class="fas fa-font text-amber-600"></i>テロップ
                                    <span class="text-xs font-normal text-gray-500">（画面上テキスト）</span>
                                </label>
                                <label class="inline-flex items-center gap-2 cursor-pointer">
                                    <input id="vbTelopsToggle" type="checkbox" class="w-4 h-4 text-amber-600 rounded" checked />
                                    <span class="text-sm text-gray-700">表示する</span>
                                </label>
                            </div>
                            <p class="text-xs text-gray-500 mt-2">
                                <i class="fas fa-info-circle text-amber-500 mr-1"></i>
                                テロップ＝シーンごとの任意テキスト表現。<br/>
                                字幕（CC）＝音声由来の自動字幕。両方同時ONも可能です。
                            </p>
                        </div>

                        <!-- モーション -->
                        <div>
                            <label class="block text-sm font-semibold text-gray-700 mb-2">
                                <i class="fas fa-running mr-1 text-indigo-600"></i>モーション（カメラの動き）
                            </label>
                            <select id="vbMotionPreset"
                                class="w-full px-3 py-2 border-2 border-gray-300 rounded-lg focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 text-sm">
                                <option value="none">動きなし</option>
                                <option value="kenburns_soft" selected>ゆっくりズーム</option>
                                <option value="kenburns_medium">ズーム（標準）</option>
                            </select>
                            <p class="text-xs text-gray-500 mt-1">
                                画像シーンにカメラワーク的な動きを付けます
                            </p>
                        </div>
                    </div>
                </div>
                
                <!-- Preflight Check Card (動画生成の準備状況) -->
                <div id="videoBuildPreflightCard" class="mb-6 bg-white rounded-xl shadow border border-gray-200">
                    <div class="p-4 border-b flex items-center justify-between">
                        <h3 class="text-lg font-bold text-gray-800 flex items-center">
                            <i class="fas fa-tasks mr-2 text-indigo-600"></i>動画生成の準備状況
                        </h3>
                        <button 
                            onclick="updateVideoBuildRequirements()"
                            class="text-gray-500 hover:text-gray-700 transition-colors text-sm flex items-center gap-1"
                            title="再チェック"
                        >
                            <i class="fas fa-sync-alt"></i>
                            <span class="hidden sm:inline">更新</span>
                        </button>
                    </div>
                    <div class="p-4">
                        <!-- 説明テキスト -->
                        <p class="text-xs text-gray-500 mb-3">
                            💡 動画を生成するには、各シーンに「画像」「漫画」「動画クリップ」のいずれかが必要です
                        </p>
                        
                        <!-- 必須チェック（素材） -->
                        <div id="preflightRequired" class="mb-4">
                            <div class="flex items-center gap-2 text-sm font-semibold text-gray-700 mb-2">
                                <span class="w-2 h-2 rounded-full bg-red-500"></span> 
                                <span>必須: 各シーンに素材（画像/漫画/動画）</span>
                            </div>
                            <div id="preflightRequiredItems" class="space-y-1 text-sm pl-4">
                                <!-- JS で埋める -->
                            </div>
                        </div>
                        
                        <!-- 推奨チェック（音声・その他） -->
                        <div id="preflightRecommended" class="mb-4">
                            <div class="flex items-center gap-2 text-sm font-semibold text-gray-700 mb-2">
                                <span class="w-2 h-2 rounded-full bg-amber-500"></span> 
                                <span>オプション: 音声（なくても生成可能）</span>
                            </div>
                            <div id="preflightRecommendedItems" class="space-y-1 text-sm pl-4">
                                <!-- JS で埋める -->
                            </div>
                        </div>
                        
                        <!-- サマリー -->
                        <div id="preflightSummary" class="p-3 rounded-lg border mt-3">
                            <!-- JS で埋める -->
                        </div>
                    </div>
                </div>
                
                <!-- Generate Button -->
                <div class="mb-6 p-4 bg-gradient-to-r from-purple-50 to-indigo-50 rounded-xl border border-purple-200">
                    <div class="flex items-center justify-between gap-4">
                        <div class="flex-1">
                            <p class="text-sm text-gray-600">
                                準備ができたら動画を生成します。生成後は「修正（チャット）」で調整できます。
                            </p>
                        </div>
                        <button 
                            id="btnStartVideoBuild"
                            onclick="startVideoBuild()"
                            class="px-6 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-semibold whitespace-nowrap touch-manipulation flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed shadow-md"
                            disabled
                        >
                            <i class="fas fa-film"></i>
                            🎬 動画を生成
                        </button>
                    </div>
                    <!-- ブロック理由の表示 -->
                    <div id="preflightBlockReason" class="hidden mt-3 p-2 bg-red-50 border border-red-200 rounded text-sm text-red-700">
                        <!-- JS で埋める -->
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
                
                <!-- Patch History (R4: SSOT Patch) -->
                <div class="bg-white rounded-lg border-2 border-gray-200 mt-6">
                    <div class="flex items-center justify-between p-4 border-b border-gray-200">
                        <h3 class="text-lg font-bold text-gray-800 flex items-center">
                            <i class="fas fa-code-branch mr-2 text-indigo-600"></i>
                            修正履歴（パッチ）
                        </h3>
                        <button 
                            onclick="loadPatchHistory()"
                            class="text-gray-600 hover:text-gray-800 transition-colors"
                            title="更新"
                        >
                            <i class="fas fa-sync-alt"></i>
                        </button>
                    </div>
                    
                    <div id="patchHistoryList" class="divide-y divide-gray-200">
                        <!-- Patches will be rendered here -->
                    </div>
                    
                    <div id="patchHistoryEmpty" class="hidden p-8 text-center">
                        <i class="fas fa-history text-4xl text-gray-300 mb-3"></i>
                        <p class="text-gray-500">修正履歴はありません</p>
                        <p class="text-sm text-gray-400 mt-1">チャットで修正指示を出すと、ここに履歴が表示されます</p>
                    </div>
                    
                    <div id="patchHistoryLoading" class="hidden p-8 text-center">
                        <i class="fas fa-spinner fa-spin text-4xl text-indigo-600 mb-3"></i>
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

    <!-- PR-4-3: Video Build Preview Modal -->
    <div id="videoBuildPreviewModal" class="hidden fixed inset-0 z-50">
        <div class="absolute inset-0 bg-black/60" onclick="closeVideoBuildPreviewModal()"></div>

        <div class="relative min-h-screen flex items-center justify-center p-4">
            <div class="w-full max-w-4xl bg-white rounded-2xl shadow-2xl overflow-hidden">
                <div class="bg-gray-900 px-5 py-4 flex items-center justify-between">
                    <div class="text-white font-bold flex items-center gap-2">
                        <i class="fas fa-film"></i>
                        <span id="vbPreviewTitle">プレビュー</span>
                        <span id="vbPreviewBuildId" class="text-xs text-white/70 ml-2"></span>
                    </div>
                    <button class="text-white/90 hover:bg-white/15 p-2 rounded-lg" onclick="closeVideoBuildPreviewModal()">
                        <i class="fas fa-times"></i>
                    </button>
                </div>

                <div class="bg-gray-950 p-4">
                    <div class="rounded-lg overflow-hidden border border-white/10">
                        <video id="vbPreviewVideo" controls class="w-full" preload="metadata">
                            <source id="vbPreviewVideoSrc" src="" type="video/mp4" />
                        </video>
                    </div>
                    
                    <!-- FIX: エラー表示エリア -->
                    <div id="vbPreviewError" class="hidden mt-3"></div>

                    <div class="mt-4 flex flex-wrap gap-2">
                        <button
                            id="vbPreviewChatEditBtn"
                            class="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-semibold flex items-center gap-2"
                        >
                            <i class="fas fa-comments"></i>修正（チャット）
                        </button>

                        <a
                            id="vbPreviewDownloadLink"
                            href="#"
                            target="_blank"
                            class="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm font-semibold flex items-center gap-2"
                        >
                            <i class="fas fa-download"></i>ダウンロード
                        </a>

                        <button
                            class="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 text-sm"
                            onclick="closeVideoBuildPreviewModal()"
                        >
                            閉じる
                        </button>
                    </div>

                    <div class="mt-3 text-xs text-gray-300">
                        ※ 修正すると「新ビルド」が作成されます（元のビルドは残ります）
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- Safe Chat v1: Chat Edit Modal (CENTER POPUP) -->
    <div id="chatEditModal" class="hidden fixed inset-0 z-50 overflow-y-auto">
        <!-- Backdrop -->
        <div id="chatEditBackdrop" class="fixed inset-0 bg-black/50" onclick="closeChatEditModal()"></div>

        <!-- Modal -->
        <div class="relative min-h-screen flex items-center justify-center p-4">
            <div class="relative w-full max-w-2xl bg-white rounded-2xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">

                <!-- Header -->
                <div class="bg-gradient-to-r from-indigo-600 to-purple-600 px-5 py-4 flex items-center justify-between">
                    <div class="flex items-center gap-3">
                        <i class="fas fa-comments text-white text-lg"></i>
                        <div>
                            <h3 class="text-white font-bold text-lg leading-tight">チャットで修正</h3>
                            <p class="text-white/80 text-xs">
                                <span id="chatEditBuildLabel">Build # -</span>
                                <span class="mx-2">•</span>
                                <span id="chatEditProjectLabel">Project -</span>
                            </p>
                            <!-- FIX2: 文脈SSOT表示 -->
                            <p id="chatEditContextLabel" class="hidden text-amber-300 text-xs font-medium mt-0.5">
                                対象: シーン1 / バブル1
                            </p>
                        </div>
                    </div>
                    <button class="text-white/90 hover:bg-white/15 p-2 rounded-lg transition-colors" onclick="closeChatEditModal()">
                        <i class="fas fa-times text-lg"></i>
                    </button>
                </div>

                <!-- Body -->
                <div class="flex-1 overflow-y-auto">
                    <!-- Video Preview (always visible, prominent) -->
                    <div class="bg-gray-900 p-4">
                        <div class="rounded-lg overflow-hidden border border-white/10">
                            <video id="chatEditVideo" controls class="w-full" preload="metadata">
                                <source id="chatEditVideoSrc" src="" type="video/mp4" />
                            </video>
                        </div>
                    </div>

                    <!-- Main Chat Area -->
                    <div class="p-4 flex flex-col">
                        <!-- PR-5-2: 拡張クイック指示（テンプレボタン）- 折りたたみ -->
                        <details class="bg-white border border-gray-200 rounded-xl mb-3">
                            <summary class="px-3 py-2 text-xs font-semibold text-gray-700 cursor-pointer hover:bg-gray-50 rounded-xl flex items-center gap-1">
                                <i class="fas fa-bolt text-amber-500 mr-1"></i>例文テンプレ（クリックで展開）
                            </summary>
                            <div class="px-3 pb-3">
                            <!-- バブル系 -->
                            <!-- バブル系 - Phase A1: パーサーと整合された形式 -->
                            <div class="mb-2">
                                <div class="text-xs text-gray-500 mb-1">💬 バブル <span class="text-purple-400 text-[10px]">(シーン/バブル自動補完)</span></div>
                                <div class="flex flex-wrap gap-1.5">
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-purple-50 text-purple-700 border border-purple-200 hover:bg-purple-100"
                                        onclick="insertChatTemplate('シーン{scene}のバブル{balloon}を喋る時だけ表示にして')">
                                        喋る時だけ
                                    </button>
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-purple-50 text-purple-700 border border-purple-200 hover:bg-purple-100"
                                        onclick="insertChatTemplate('シーン{scene}のバブル{balloon}を常時表示にして')">
                                        常時表示
                                    </button>
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-purple-50 text-purple-700 border border-purple-200 hover:bg-purple-100"
                                        onclick="insertChatTemplate('シーン{scene}のバブル{balloon}を+300ms遅らせて')">
                                        +300ms遅らせ
                                    </button>
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-purple-50 text-purple-700 border border-purple-200 hover:bg-purple-100"
                                        onclick="insertChatTemplate('シーン{scene}のバブル{balloon}を手動表示にして、開始0ms、終了1800ms')">
                                        手動タイミング(ms)
                                    </button>
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-purple-50 text-purple-700 border border-purple-200 hover:bg-purple-100"
                                        onclick="insertChatTemplate('シーン{scene}のバブル{balloon}を3秒から5秒まで表示')">
                                        秒数指定(例:3秒〜5秒)
                                    </button>
                                </div>
                            </div>
                            <!-- BGM系 -->
                            <div class="mb-2">
                                <div class="text-xs text-gray-500 mb-1">🎵 BGM</div>
                                <div class="flex flex-wrap gap-1.5">
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100"
                                        onclick="insertChatTemplate('BGMをON、音量を15%に')">
                                        ON + 音量
                                    </button>
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100"
                                        onclick="insertChatTemplate('BGM音量を20%に')">
                                        音量変更
                                    </button>
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100"
                                        onclick="insertChatTemplate('BGMをOFFにして')">
                                        OFF
                                    </button>
                                </div>
                            </div>
                            <!-- SFX系 - Phase A1: パーサーと整合された形式 -->
                            <div class="mb-2">
                                <div class="text-xs text-gray-500 mb-1">🔔 効果音 <span class="text-blue-400 text-[10px]">(シーン自動補完)</span></div>
                                <div class="flex flex-wrap gap-1.5">
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100"
                                        onclick="insertChatTemplate('シーン{scene}のSFX1の音量を50%に')">
                                        SFX音量50%
                                    </button>
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100"
                                        onclick="insertChatTemplate('シーン{scene}のSFX1の音量を30%に')">
                                        SFX音量30%
                                    </button>
                                </div>
                            </div>
                            <!-- PR-5-3b: テロップ系 -->
                            <div>
                                <div class="text-xs text-gray-500 mb-1">📝 テロップ</div>
                                <div class="flex flex-wrap gap-1.5">
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-orange-50 text-orange-700 border border-orange-200 hover:bg-orange-100"
                                        onclick="insertChatTemplate('シーン{scene}のテロップをOFFにして')">
                                        このシーンOFF
                                    </button>
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-orange-50 text-orange-700 border border-orange-200 hover:bg-orange-100"
                                        onclick="insertChatTemplate('シーン{scene}のテロップをONにして')">
                                        このシーンON
                                    </button>
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-orange-50 text-orange-700 border border-orange-200 hover:bg-orange-100"
                                        onclick="insertChatTemplate('テロップを全部OFF')">
                                        全OFF
                                    </button>
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-orange-50 text-orange-700 border border-orange-200 hover:bg-orange-100"
                                        onclick="insertChatTemplate('テロップを全部ON')">
                                        全ON
                                    </button>
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-orange-50 text-orange-700 border border-orange-200 hover:bg-orange-100"
                                        onclick="insertChatTemplate('テロップ位置を上に')">
                                        位置：上
                                    </button>
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-orange-50 text-orange-700 border border-orange-200 hover:bg-orange-100"
                                        onclick="insertChatTemplate('テロップ位置を中央に')">
                                        位置：中央
                                    </button>
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-orange-50 text-orange-700 border border-orange-200 hover:bg-orange-100"
                                        onclick="insertChatTemplate('テロップサイズを大に')">
                                        サイズ：大
                                    </button>
                                </div>
                            </div>
                        </div>
                        </details>

                        <!-- History -->
                        <div id="chatEditHistory" class="flex-1 overflow-y-auto mt-3 space-y-3 pr-1 min-h-[200px] max-h-[300px]"></div>

                        <!-- Dry-run Result (安心感のあるUI) -->
                        <div id="chatEditDryRunBox" class="hidden mt-3 bg-gradient-to-r from-green-50 to-emerald-50 border border-green-200 rounded-xl p-4 shadow-sm">
                            <div class="flex items-center justify-between mb-3">
                                <div class="flex items-center gap-2">
                                    <span class="flex items-center justify-center w-8 h-8 bg-green-100 rounded-full">
                                        <i class="fas fa-clipboard-check text-green-600"></i>
                                    </span>
                                    <div>
                                        <p class="font-semibold text-green-900 text-sm">変更内容の確認</p>
                                        <p class="text-xs text-green-600">以下の変更が適用されます</p>
                                    </div>
                                </div>
                                <span id="chatEditDryRunBadge" class="text-xs px-2 py-1 rounded-full bg-green-100 text-green-700 font-medium">-</span>
                            </div>

                            <div id="chatEditDryRunChanges" class="space-y-2 max-h-32 overflow-y-auto bg-white rounded-lg p-2 border border-green-100"></div>

                            <div id="chatEditDryRunErrors" class="hidden mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-2"></div>

                            <div class="mt-4 p-3 bg-blue-50 border border-blue-100 rounded-lg">
                                <p class="text-xs text-blue-700 flex items-center">
                                    <i class="fas fa-shield-alt text-blue-500 mr-2"></i>
                                    <span><strong>安心ポイント:</strong> 元のビルドは残ります。新しいビルドを作成するので、いつでも戻せます。</span>
                                </p>
                            </div>

                            <div class="mt-3 flex gap-2">
                                <button
                                    id="btnChatEditApply"
                                    class="flex-1 px-4 py-2.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                                    onclick="applyChatEdit()"
                                >
                                    <i class="fas fa-magic mr-1"></i>この変更を適用する
                                </button>
                                <button
                                    class="px-4 py-2.5 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 transition-colors text-sm"
                                    onclick="cancelChatEditDryRun()"
                                >
                                    やめる
                                </button>
                            </div>
                            
                            <!-- C3: Explain Block (AI解釈の可視化) -->
                            <div id="chatEditExplainBox" class="hidden mt-3 border-t border-amber-200 pt-3">
                                <div class="flex items-center justify-between mb-2">
                                    <button onclick="toggleExplainBlock()" class="flex items-center gap-1.5 text-xs font-semibold text-gray-700 hover:text-purple-700 transition-colors">
                                        <i class="fas fa-microscope text-purple-500"></i>
                                        解釈詳細（Explain）
                                        <i id="chatEditExplainToggle" class="fas fa-chevron-up text-gray-400"></i>
                                    </button>
                                    <button onclick="copyExplainToClipboard()" 
                                        class="px-2 py-0.5 text-[10px] bg-gray-100 hover:bg-gray-200 rounded text-gray-600 transition-colors"
                                        title="サポート用にコピー">
                                        <i class="fas fa-copy"></i>
                                    </button>
                                </div>
                                <div id="chatEditExplainContent" class="text-xs space-y-2">
                                    <!-- Dynamically rendered by renderExplainBlock() -->
                                </div>
                            </div>
                        </div>

                        <!-- Input Section -->
                        <div class="mt-3 border-t pt-3 bg-gray-50 -mx-4 px-4 pb-2">
                            <!-- Input area with inline context -->
                            <div class="flex gap-2 items-end">
                                <div class="flex-1">
                                    <textarea
                                        id="chatEditInput"
                                        rows="2"
                                        class="w-full px-3 py-2 border border-purple-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm resize-none"
                                        placeholder="修正指示を入力 / Enterで送信"
                                    ></textarea>
                                </div>
                                <button
                                    id="btnChatEditSend"
                                    class="px-4 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
                                    onclick="sendChatEditMessage()"
                                >
                                    <i class="fas fa-paper-plane"></i>
                                </button>
                            </div>
                            
                            <!-- Options row -->
                            <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                                <!-- AI toggle -->
                                <label class="flex items-center gap-1.5 cursor-pointer">
                                    <input id="chatEditUseAiToggle" type="checkbox" checked
                                        class="w-3.5 h-3.5 text-purple-600 rounded focus:ring-purple-500" />
                                    <span class="text-purple-700 font-medium">
                                        <i class="fas fa-magic mr-0.5"></i>AI解釈
                                    </span>
                                </label>
                                <span id="chatEditParseMode" class="px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 text-[10px] hidden">
                                    AI
                                </span>
                                
                                <!-- Context selectors (hidden, for template use) -->
                                <div class="hidden">
                                    <select id="chatEditContextScene"><option value="1">1</option></select>
                                    <input id="chatEditContextBalloon" type="number" min="1" value="1" />
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Footer removed for cleaner UI -->

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
                        
                        <!-- R2-C: Rendering Result Preview (what will be output) -->
                        <div id="rendering-preview-container">
                            <!-- Dynamically populated by scene-edit-modal.js -->
                        </div>
                        
                        <!-- R2-C: Motion Preset (dynamically populated by scene-edit-modal.js) -->
                        <div id="motion-selector-container">
                            <!-- Loading placeholder -->
                            <div class="animate-pulse p-4 border border-gray-200 rounded-lg bg-gray-50">
                                <div class="h-4 bg-gray-200 rounded w-1/4 mb-2"></div>
                                <div class="h-10 bg-gray-200 rounded"></div>
                            </div>
                        </div>
                        
                        <!-- R3-A: Duration Override (for silent scenes) -->
                        <div id="duration-override-container">
                            <!-- Dynamically populated by scene-edit-modal.js -->
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
                    
                    <!-- Tab B: Utterances (R1.5 音声タブ) -->
                    <div id="scene-edit-tab-utterances" class="hidden space-y-4">
                        <!-- Dynamically populated by UtterancesTab -->
                    </div>
                    
                    <!-- Tab C: Character Traits -->
                    <div id="scene-edit-tab-traits" class="hidden space-y-4">
                        <!-- Dynamically populated -->
                    </div>
                    
                    <!-- Tab D: SFX (R3-B) -->
                    <div id="scene-edit-tab-sfx" class="hidden space-y-4">
                        <!-- Dynamically populated by scene-edit-modal.js -->
                    </div>
                    
                    <!-- Tab E: BGM (P3) -->
                    <div id="scene-edit-tab-bgm" class="hidden space-y-4">
                        <!-- BGM管理タブ -->
                        <div class="p-4 bg-amber-50 rounded-lg border border-amber-200">
                            <p class="text-sm text-amber-700">
                                <i class="fas fa-info-circle mr-1"></i>
                                <strong>シーン別BGM</strong>を設定できます。シーン別BGMは全体BGMより優先されます。
                            </p>
                        </div>
                        
                        <!-- プロジェクト全体BGM表示 -->
                        <div id="scene-bgm-project-bgm" class="p-4 bg-gray-50 rounded-lg border border-gray-200">
                            <h4 class="font-semibold text-gray-700 mb-2">
                                <i class="fas fa-music mr-2 text-gray-500"></i>プロジェクト全体BGM
                            </h4>
                            <div id="scene-bgm-project-info" class="text-sm text-gray-600">
                                <!-- Populated dynamically -->
                            </div>
                        </div>
                        
                        <!-- シーン別BGM設定 -->
                        <div class="p-4 bg-white rounded-lg border border-amber-300">
                            <h4 class="font-semibold text-amber-700 mb-3">
                                <i class="fas fa-layer-group mr-2"></i>このシーンのBGM
                            </h4>
                            
                            <!-- 現在のシーンBGM -->
                            <div id="scene-bgm-current" class="mb-4">
                                <!-- Populated dynamically -->
                            </div>
                            
                            <!-- BGM設定オプション -->
                            <div class="space-y-3">
                                <div class="flex gap-2">
                                    <button id="scene-bgm-select-btn" 
                                        class="flex-1 px-4 py-2 bg-amber-500 text-white rounded-lg hover:bg-amber-600 transition-colors text-sm font-semibold">
                                        <i class="fas fa-folder-open mr-1"></i>ライブラリから選択
                                    </button>
                                    <button id="scene-bgm-upload-btn"
                                        class="flex-1 px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition-colors text-sm font-semibold">
                                        <i class="fas fa-upload mr-1"></i>アップロード
                                    </button>
                                </div>
                                
                                <div id="scene-bgm-remove-container" class="hidden">
                                    <button id="scene-bgm-remove-btn"
                                        class="w-full px-4 py-2 bg-red-100 text-red-600 rounded-lg hover:bg-red-200 transition-colors text-sm font-semibold">
                                        <i class="fas fa-trash-alt mr-1"></i>シーンBGMを削除（全体BGMに戻す）
                                    </button>
                                </div>
                            </div>
                            
                            <!-- 音量調整 -->
                            <div id="scene-bgm-volume-container" class="hidden mt-4 p-3 bg-amber-50 rounded-lg">
                                <label class="block text-sm font-semibold text-amber-700 mb-2">
                                    <i class="fas fa-volume-up mr-1"></i>シーンBGM音量
                                </label>
                                <input type="range" id="scene-bgm-volume" min="0" max="100" value="25" 
                                    class="w-full h-2 bg-amber-200 rounded-lg appearance-none cursor-pointer">
                                <div class="flex justify-between text-xs text-amber-600 mt-1">
                                    <span>0%</span>
                                    <span id="scene-bgm-volume-value">25%</span>
                                    <span>100%</span>
                                </div>
                            </div>
                        </div>
                        
                        <!-- 隠しファイル入力 -->
                        <input type="file" id="scene-bgm-file-input" accept="audio/*" class="hidden">
                    </div>
                </div>
                
                <!-- Footer -->
                <div class="bg-gray-50 px-6 py-4 rounded-b-xl flex gap-3 justify-between">
                    <!-- Left: Chat Edit Button (C1-3) -->
                    <div>
                        <button 
                            id="scene-chat-edit-btn"
                            onclick="openChatEditFromSceneModal()"
                            class="px-4 py-2 bg-amber-500 text-white rounded-lg hover:bg-amber-600 transition-colors font-semibold"
                            title="このシーンをチャットで修正（バブル、BGM、効果音など）"
                        >
                            <i class="fas fa-comments mr-2"></i>チャットで修正
                        </button>
                    </div>
                    <!-- Right: Cancel / Save -->
                    <div class="flex gap-3">
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
        // SSOT: Configure axios to always send credentials (cookies) for authentication
        axios.defaults.withCredentials = true;
        
        // Backward compatible global project id
        window.PROJECT_ID = ${projectId};
        // Keep legacy access (PROJECT_ID) for existing scripts
        const PROJECT_ID = window.PROJECT_ID;
    </script>
    <script src="/static/audio-client.js?v=${ASSET_VERSION}"></script>
    <script src="/static/audio-state.js?v=${ASSET_VERSION}"></script>
    <script src="/static/audio-ui.js?v=${ASSET_VERSION}"></script>
    <script src="/static/world-character-client.js?v=${ASSET_VERSION}"></script>
    <script src="/static/world-character-modal.js?v=${ASSET_VERSION}"></script>
    <script src="/static/world-character-ui.js?v=${ASSET_VERSION}"></script>
    <script src="/static/character-library.js?v=${ASSET_VERSION}"></script>
    <script src="/static/scene-edit-modal.js?v=${ASSET_VERSION}"></script>
    <script src="/static/utterances-tab.js?v=${ASSET_VERSION}"></script>
    <script src="/static/character-trait-modal.js?v=${ASSET_VERSION}"></script>
    <!-- comic-editor v1 は凍結（Phase1.6 SSOT再構築中） -->
    <!-- <script src="/static/comic-editor.js"></script> -->
    <script src="/static/comic-editor-v2.js?v=${ASSET_VERSION}"></script>
    <script src="/static/project-editor.js?v=${ASSET_VERSION}"></script>
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
        // SSOT: Configure axios to always send credentials (cookies) for authentication
        axios.defaults.withCredentials = true;
        
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
        // SSOT: Configure axios to always send credentials (cookies) for authentication
        axios.defaults.withCredentials = true;
        
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
        // SSOT: Configure axios to always send credentials (cookies) for authentication
        axios.defaults.withCredentials = true;
        
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
        // SSOT: Configure axios to always send credentials (cookies) for authentication
        axios.defaults.withCredentials = true;
        
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
        // SSOT: Configure axios to always send credentials (cookies) for authentication
        axios.defaults.withCredentials = true;
        
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
