import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'
import type { Bindings } from './types/bindings'

// Asset version for cache busting
// Priority: 1) CF_PAGES_COMMIT_SHA (Cloudflare Pages git deploy)
//           2) env.ASSET_VERSION (CI/CD or wrangler secret)
//           3) __BUILD_VERSION__ (Vite build-time git hash)
//           4) 'dev' fallback
// IMPORTANT: Always run `npm run build` AFTER the final git commit, BEFORE deploy.
// The build bakes `git rev-parse --short HEAD` into the bundle.

// __BUILD_VERSION__ is replaced by Vite's define at build time with git hash or timestamp
declare const __BUILD_VERSION__: string;

/**
 * Get asset version for cache busting
 * @param env - Cloudflare environment bindings
 * @returns version string for ?v= query parameter
 */
function getAssetVersion(env?: Bindings): string {
  // 1. CF_PAGES_COMMIT_SHA (highest priority - set by Cloudflare Pages on git-connected deploys)
  if (env?.CF_PAGES_COMMIT_SHA) {
    return (env.CF_PAGES_COMMIT_SHA as string).substring(0, 7);
  }
  // 2. Environment variable (set by CI/CD or wrangler secret)
  if (env?.ASSET_VERSION) {
    return env.ASSET_VERSION;
  }
  // 3. Build version (replaced during build with git hash)
  try {
    if (typeof __BUILD_VERSION__ !== 'undefined' && __BUILD_VERSION__) {
      return __BUILD_VERSION__;
    }
  } catch {
    // __BUILD_VERSION__ not defined (development mode)
  }
  // 4. Fallback (development)
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
import bulkAudio from './routes/bulk-audio' // Step3: Bulk audio generation
import marunage from './routes/marunage' // Marunage Chat MVP
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

// Bulk audio generation routes
app.route('/api', bulkAudio) // For /api/projects/:projectId/audio/bulk-*

// Marunage Chat MVP routes
app.route('/api/marunage', marunage) // For /api/marunage/*

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
    <title>MARUMUVI</title>
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
                    MARUMUVI
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
            <!-- 動画を作る: 2つの動線 -->
            <div class="mb-8">
                <h2 class="text-lg font-semibold text-gray-700 mb-4">
                    <i class="fas fa-film mr-2 text-blue-600"></i>
                    動画を作る
                </h2>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <!-- 動線1: プロジェクト作成（既存フロー） -->
                    <div id="createFlowCard" class="bg-white rounded-xl shadow-md hover:shadow-lg transition-all cursor-pointer border-2 border-transparent hover:border-blue-400 group" onclick="document.getElementById('projectCreateSection').classList.toggle('hidden')">
                        <div class="p-6">
                            <div class="flex items-center mb-3">
                                <div class="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center mr-4 group-hover:bg-blue-200 transition-colors">
                                    <i class="fas fa-layer-group text-blue-600 text-xl"></i>
                                </div>
                                <div>
                                    <h3 class="text-lg font-bold text-gray-800">プロジェクト作成</h3>
                                    <p class="text-sm text-gray-500">シーンを一つずつ作り込む</p>
                                </div>
                            </div>
                            <p class="text-sm text-gray-600 leading-relaxed">
                                シナリオ入力 → シーン分割 → 画像生成 → 動画化 → 合成まで、各ステップを細かくコントロールしながら動画を作成できます。
                            </p>
                            <div class="mt-4 flex items-center text-blue-600 text-sm font-medium">
                                <span>はじめる</span>
                                <i class="fas fa-chevron-right ml-1 text-xs"></i>
                            </div>
                        </div>
                    </div>

                    <!-- 動線2: 丸投げチャット（β版） -->
                    <a href="/marunage" class="bg-white rounded-xl shadow-md hover:shadow-lg transition-all cursor-pointer border-2 border-transparent hover:border-purple-400 group block relative overflow-hidden">
                        <div class="p-6">
                            <div class="flex items-center mb-3">
                                <div class="w-12 h-12 bg-purple-100 rounded-xl flex items-center justify-center mr-4 group-hover:bg-purple-200 transition-colors">
                                    <i class="fas fa-comments text-purple-600 text-xl"></i>
                                </div>
                                <div>
                                    <h3 class="text-lg font-bold text-gray-800">丸投げチャット</h3>
                                    <p class="text-sm text-gray-500">チャットで指示するだけで動画素材を自動生成</p>
                                </div>
                            </div>
                            <p class="text-sm text-gray-600 leading-relaxed">
                                シナリオを貼るだけでシーン画像・ナレーション音声・BGM・SEを自動生成。漫画コマ・I2V動画変換にも対応し、チャットからの編集指示で微調整まで完結します。
                            </p>
                            <div class="mt-4 flex items-center text-purple-600 text-sm font-medium">
                                <span>はじめる</span>
                                <i class="fas fa-chevron-right ml-1 text-xs"></i>
                            </div>
                        </div>
                        <!-- β版バッジ -->
                        <div class="absolute top-3 right-3">
                            <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold bg-purple-100 text-purple-800 border border-purple-300">
                                <i class="fas fa-flask mr-1"></i>Beta
                            </span>
                        </div>
                    </a>
                </div>
            </div>

            <!-- プロジェクト作成セクション（トグル表示） -->
            <div id="projectCreateSection" class="bg-white rounded-lg shadow-md p-6 mb-6">
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

app.get('/projects/:id', async (c) => {
  const projectId = c.req.param('id')
  const ASSET_VERSION = getAssetVersion(c.env)

  // ── Marunage guard: block marunage projects from Builder ──
  // Uses json_extract in SQL to avoid JSON.parse failure on corrupted settings_json
  try {
    const proj = await c.env.DB.prepare(
      `SELECT json_extract(settings_json, '$.marunage_mode') as is_marunage
       FROM projects
       WHERE id = ? AND (is_deleted = 0 OR is_deleted IS NULL)
       LIMIT 1`
    ).bind(projectId).first<{ is_marunage: number | null }>()
    if (proj?.is_marunage === 1) {
      const run = await c.env.DB.prepare(
        `SELECT id FROM marunage_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`
      ).bind(projectId).first<{ id: string | number }>()
      return c.redirect(run ? '/marunage-chat?run=' + String(run.id) : '/marunage')
    }
  } catch (_) { /* DB error → fall through to normal Builder */ }

  return c.html(`

<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <title>Project Editor - MARUMUVI</title>
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
                    
                    <!-- Current Mode Display (SSOT) -->
                    <div id="savedSplitModeContainer" class="mb-3 p-2 bg-white rounded border border-purple-200 hidden">
                        <span class="text-xs text-gray-500">前回の分割モード: </span>
                        <span id="savedSplitModeDisplay" class="text-sm font-semibold text-purple-700">-</span>
                    </div>
                    
                    <!-- Split Mode Selection (SSOT: raw / optimized) -->
                    <div class="mb-4">
                        <label class="text-sm font-medium text-gray-700 mb-2 block">
                            分割モード <span class="text-red-500">*</span>
                            <span class="text-xs text-gray-500 ml-2">（必須選択）</span>
                        </label>
                        <div class="space-y-2">
                            <label id="splitModeRawLabel" class="flex items-start gap-3 p-3 bg-white rounded-lg border-2 border-gray-200 cursor-pointer hover:border-green-400 transition-colors">
                                <input type="radio" name="splitMode" value="raw" class="mt-1" onchange="onSplitModeChange('raw')">
                                <div class="flex-1">
                                    <div class="flex items-center gap-2">
                                        <span class="font-medium text-gray-800">原文そのまま（Raw）</span>
                                        <span class="px-2 py-0.5 text-xs bg-green-100 text-green-700 rounded-full">推奨</span>
                                    </div>
                                    <div class="text-xs text-gray-500 mt-1">
                                        <i class="fas fa-check text-green-600 mr-1"></i>原文を一切削りません。空行（段落）で分割し、各段落をそのまま1シーンにします。<br>
                                        <span class="text-purple-600"><i class="fas fa-magic mr-1"></i>画像プロンプトのみAI生成</span>
                                    </div>
                                </div>
                            </label>
                            <label id="splitModeOptimizedLabel" class="flex items-start gap-3 p-3 bg-white rounded-lg border-2 border-gray-200 cursor-pointer hover:border-amber-400 transition-colors">
                                <input type="radio" name="splitMode" value="optimized" class="mt-1" onchange="onSplitModeChange('optimized')">
                                <div class="flex-1">
                                    <div class="font-medium text-gray-800">AIで整形（Optimized）</div>
                                    <div class="text-xs text-gray-500 mt-1">
                                        AIが意図を読み取り、適切に分割・整理します。<br>
                                        <span class="text-amber-600"><i class="fas fa-exclamation-triangle mr-1"></i>文章が要約・再構成される場合があります</span>
                                    </div>
                                </div>
                            </label>
                        </div>
                        <p id="splitModeNotSelectedWarning" class="text-xs text-red-600 mt-2 hidden">
                            <i class="fas fa-exclamation-circle mr-1"></i>分割モードを選択してください
                        </p>
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
                
                <!-- Scenes Section with Visible/Hidden Tabs -->
                <div id="scenesSection" class="hidden">
                    <!-- Tab Navigation -->
                    <div class="flex items-center justify-between mb-4">
                        <div class="flex items-center gap-1 bg-gray-100 p-1 rounded-lg">
                            <button 
                                id="visibleScenesTab"
                                onclick="switchSceneTab('visible')"
                                class="px-4 py-2 rounded-md font-semibold transition-all text-sm"
                            >
                                <i class="fas fa-eye mr-1"></i>
                                表示中（<span id="scenesCount">0</span>）
                            </button>
                            <button 
                                id="hiddenScenesTab"
                                onclick="switchSceneTab('hidden')"
                                class="px-4 py-2 rounded-md font-semibold transition-all text-sm"
                            >
                                <i class="fas fa-eye-slash mr-1"></i>
                                非表示（<span id="hiddenScenesCount">0</span>）
                            </button>
                        </div>
                        <div class="flex gap-2">
                            <button 
                                id="addSceneBtn"
                                onclick="showAddSceneModal()"
                                class="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-semibold touch-manipulation"
                                title="新規シーンを追加"
                            >
                                <i class="fas fa-plus mr-1"></i>シーン追加
                            </button>
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
                    
                    <!-- Visible Scenes List -->
                    <div id="visibleScenesContent">
                        <div id="scenesList" class="space-y-4">
                            <!-- Scenes will be rendered here -->
                        </div>
                    </div>
                    
                    <!-- Hidden Scenes List -->
                    <div id="hiddenScenesContent" class="hidden">
                        <div class="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                            <p class="text-sm text-amber-800">
                                <i class="fas fa-info-circle mr-1"></i>
                                非表示シーンは動画に含まれません。「復元」で再度表示できます。
                            </p>
                        </div>
                        <div id="hiddenScenesList" class="space-y-3">
                            <!-- Hidden scenes will be rendered here -->
                        </div>
                        <div id="hiddenScenesEmpty" class="hidden text-center py-8">
                            <i class="fas fa-check-circle text-4xl text-green-400 mb-3"></i>
                            <p class="text-gray-500">非表示のシーンはありません</p>
                        </div>
                    </div>
                </div>
                
                <!-- Empty State -->
                <div id="scenesEmptyState" class="text-center py-12 hidden">
                    <i class="fas fa-inbox text-6xl text-gray-300 mb-4"></i>
                    <p class="text-gray-600">シーンがありません。上の「シーン分割を実行」ボタンを押してください。</p>
                </div>
                
                <!-- Add Scene Modal (Scene Split用) -->
                <div id="addSceneModalSplit" class="hidden fixed inset-0 z-50 overflow-y-auto">
                    <div class="fixed inset-0 bg-black/50" onclick="closeAddSceneModal()"></div>
                    <div class="relative min-h-screen flex items-center justify-center p-4">
                        <div class="relative w-full max-w-lg bg-white rounded-xl shadow-2xl overflow-hidden">
                            <div class="bg-gradient-to-r from-green-600 to-teal-600 px-5 py-4 flex items-center justify-between">
                                <div class="flex items-center gap-3">
                                    <i class="fas fa-plus-circle text-white text-lg"></i>
                                    <h3 class="text-white font-bold text-lg">シーン追加</h3>
                                </div>
                                <button class="text-white/90 hover:bg-white/15 p-2 rounded-lg transition-colors" onclick="closeAddSceneModal()">
                                    <i class="fas fa-times text-lg"></i>
                                </button>
                            </div>
                            <!-- Tab切り替え -->
                            <div class="flex border-b border-gray-200">
                                <button id="addSceneTab-new" onclick="switchAddSceneTab('new')"
                                    class="flex-1 px-4 py-3 text-sm font-semibold text-center border-b-2 border-green-600 text-green-700 bg-green-50 transition-colors">
                                    <i class="fas fa-plus mr-1"></i>新規作成
                                </button>
                                <button id="addSceneTab-copy" onclick="switchAddSceneTab('copy')"
                                    class="flex-1 px-4 py-3 text-sm font-semibold text-center border-b-2 border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50 transition-colors">
                                    <i class="fas fa-copy mr-1"></i>既存シーンからコピー
                                </button>
                            </div>
                            <!-- 新規作成パネル -->
                            <div id="addScenePanel-new" class="p-6 space-y-4">
                                <div>
                                    <label class="block text-sm font-semibold text-gray-700 mb-2">
                                        <i class="fas fa-list-ol mr-1 text-green-600"></i>挿入位置
                                    </label>
                                    <select id="addScenePosition" class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500">
                                        <option value="end">最後に追加</option>
                                    </select>
                                    <p class="text-xs text-gray-500 mt-1">
                                        <i class="fas fa-info-circle mr-1"></i>既存シーンの後に挿入する場合は位置を選択
                                    </p>
                                </div>
                                <div>
                                    <label class="block text-sm font-semibold text-gray-700 mb-2">
                                        <i class="fas fa-heading mr-1 text-blue-600"></i>タイトル（省略可）
                                    </label>
                                    <input type="text" id="addSceneTitle" placeholder="シーンのタイトル..."
                                        class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500" />
                                </div>
                                <div>
                                    <label class="block text-sm font-semibold text-gray-700 mb-2">
                                        <i class="fas fa-comment mr-1 text-purple-600"></i>セリフ/ナレーション（省略可）
                                    </label>
                                    <textarea id="addSceneDialogue" rows="4" placeholder="セリフやナレーションを入力..."
                                        class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"></textarea>
                                </div>
                            </div>
                            <!-- コピーパネル -->
                            <div id="addScenePanel-copy" class="hidden p-6 space-y-4">
                                <div class="bg-indigo-50 border border-indigo-200 rounded-lg p-3 text-sm text-indigo-700">
                                    <i class="fas fa-info-circle mr-1"></i>
                                    コピー元のシーンを選択してください。タイトル・セリフ・要点・プロンプト・キャラクター割り当てがコピーされます。画像・動画・漫画はコピーされません。
                                </div>
                                <div>
                                    <label class="block text-sm font-semibold text-gray-700 mb-2">
                                        <i class="fas fa-copy mr-1 text-indigo-600"></i>コピー元シーン
                                    </label>
                                    <select id="copySceneSource" class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500">
                                        <option value="">-- シーンを選択 --</option>
                                    </select>
                                </div>
                                <div>
                                    <label class="block text-sm font-semibold text-gray-700 mb-2">
                                        <i class="fas fa-list-ol mr-1 text-green-600"></i>挿入位置
                                    </label>
                                    <select id="copyScenePosition" class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500">
                                        <option value="end">最後に追加</option>
                                    </select>
                                </div>
                                <!-- コピー元プレビュー -->
                                <div id="copyScenePreview" class="hidden bg-gray-50 border border-gray-200 rounded-lg p-4">
                                    <h4 class="text-sm font-semibold text-gray-600 mb-2"><i class="fas fa-eye mr-1"></i>プレビュー</h4>
                                    <div id="copyScenePreviewContent" class="text-sm text-gray-700 space-y-1"></div>
                                </div>
                            </div>
                            <!-- フッターボタン -->
                            <div class="px-6 py-4 bg-gray-50 border-t flex justify-end gap-3">
                                <button onclick="closeAddSceneModal()" class="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors font-semibold">
                                    キャンセル
                                </button>
                                <button id="addSceneConfirmBtn" onclick="confirmAddScene()" class="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-semibold inline-flex items-center gap-2">
                                    <i class="fas fa-plus"></i>追加
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- Restore Scene Confirmation Modal (2段階確認) -->
                <div id="restoreSceneModal" class="hidden fixed inset-0 z-50 overflow-y-auto">
                    <div class="fixed inset-0 bg-black/50" onclick="closeRestoreSceneModal()"></div>
                    <div class="relative min-h-screen flex items-center justify-center p-4">
                        <div class="relative w-full max-w-md bg-white rounded-xl shadow-2xl overflow-hidden">
                            <div class="bg-gradient-to-r from-blue-600 to-indigo-600 px-5 py-4 flex items-center justify-between">
                                <div class="flex items-center gap-3">
                                    <i class="fas fa-undo text-white text-lg"></i>
                                    <h3 class="text-white font-bold text-lg">シーンを復元</h3>
                                </div>
                                <button class="text-white/90 hover:bg-white/15 p-2 rounded-lg transition-colors" onclick="closeRestoreSceneModal()">
                                    <i class="fas fa-times text-lg"></i>
                                </button>
                            </div>
                            <div class="p-6">
                                <div class="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                                    <p class="text-sm text-blue-800 font-semibold" id="restoreSceneTitle">
                                        <!-- Scene title will be shown here -->
                                    </p>
                                </div>
                                <p class="text-gray-700 mb-4">
                                    このシーンを復元しますか？復元後、シーン一覧の末尾に追加されます。
                                </p>
                                <div id="restoreSceneStats" class="text-sm text-gray-600 mb-4">
                                    <!-- Stats will be shown here -->
                                </div>
                                <div class="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
                                    <p class="text-xs text-amber-700">
                                        <i class="fas fa-exclamation-triangle mr-1"></i>
                                        復元後の idx は末尾に配置されます。必要に応じて並び替えてください。
                                    </p>
                                </div>
                            </div>
                            <div class="px-6 py-4 bg-gray-50 border-t flex justify-end gap-3">
                                <button onclick="closeRestoreSceneModal()" class="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors font-semibold">
                                    キャンセル
                                </button>
                                <button onclick="confirmRestoreScene()" id="restoreSceneConfirmBtn" class="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-semibold inline-flex items-center gap-2">
                                    <i class="fas fa-undo"></i>復元する
                                </button>
                            </div>
                        </div>
                    </div>
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
                    
                    <!-- P0-1: ナレーションデフォルトボイス設定 -->
                    <div class="bg-white rounded-lg border border-gray-200 p-4">
                        <div class="flex items-center justify-between mb-3">
                            <div class="flex items-center gap-2">
                                <i class="fas fa-microphone-alt text-purple-600"></i>
                                <span class="font-semibold text-gray-800 text-sm">ナレーション音声</span>
                                <span id="narrationVoiceStatus" class="text-xs px-2 py-0.5 bg-gray-100 text-gray-500 rounded-full">未設定</span>
                            </div>
                            <button id="narrationVoiceEditBtn" onclick="toggleNarrationVoicePanel()" 
                                class="text-xs px-3 py-1 bg-purple-100 text-purple-700 rounded-lg hover:bg-purple-200 transition-colors">
                                <i class="fas fa-cog mr-1"></i>設定
                            </button>
                        </div>
                        <p class="text-xs text-gray-500">
                            <i class="fas fa-info-circle mr-1"></i>
                            ナレーション発話のデフォルト音声を設定します。キャラクター発話は各キャラに紐づいた声が使われます。
                        </p>
                        <!-- P0-1: 設定パネル（非表示→トグル） -->
                        <div id="narrationVoicePanel" class="hidden mt-3 p-3 bg-purple-50 rounded-lg border border-purple-200">
                            <label class="block text-xs font-semibold text-gray-700 mb-1">音声プリセット</label>
                            <div class="flex gap-2">
                                <select id="narrationVoiceSelect" class="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm">
                                    <option value="">選択してください</option>
                                    <optgroup label="Google TTS (日本語)">
                                        <option value="google:ja-JP-Neural2-B">ja-JP-Neural2-B (女性・落ち着き)</option>
                                        <option value="google:ja-JP-Neural2-C">ja-JP-Neural2-C (男性・明るい)</option>
                                        <option value="google:ja-JP-Neural2-D">ja-JP-Neural2-D (男性・若々しい)</option>
                                        <option value="google:ja-JP-Wavenet-A">ja-JP-Wavenet-A (女性・ソフト)</option>
                                        <option value="google:ja-JP-Wavenet-B">ja-JP-Wavenet-B (女性・自然)</option>
                                        <option value="google:ja-JP-Wavenet-C">ja-JP-Wavenet-C (男性・自然)</option>
                                        <option value="google:ja-JP-Wavenet-D">ja-JP-Wavenet-D (男性・低音)</option>
                                    </optgroup>
                                    <optgroup label="ElevenLabs (高品質・多言語)">
                                        <option value="elevenlabs:el-aria">Aria（女性・落ち着き）</option>
                                        <option value="elevenlabs:el-sarah">Sarah（女性・優しい）</option>
                                        <option value="elevenlabs:el-charlotte">Charlotte（女性・明るい）</option>
                                        <option value="elevenlabs:el-lily">Lily（若い女性）</option>
                                        <option value="elevenlabs:el-adam">Adam（男性・深い）</option>
                                        <option value="elevenlabs:el-bill">Bill（男性・自然）</option>
                                        <option value="elevenlabs:el-brian">Brian（男性・プロ）</option>
                                        <option value="elevenlabs:el-george">George（男性・落ち着き）</option>
                                        <option value="elevenlabs:el-hinata">Hinata（男性・日本語）</option>
                                        <option value="elevenlabs:el-yumi">Yumi（女性・日本語・落ち着き）</option>
                                    </optgroup>
                                    <optgroup label="Fish Audio (日本語特化)">
                                        <option value="fish:fish-nanamin">Nanamin（男性・アニメ）</option>
                                    </optgroup>
                                    <!-- プロジェクトキャラクターの音声はJSで動的に追加 -->
                                </select>
                                <button id="narrationVoicePreviewBtn" onclick="previewNarrationVoice()"
                                    class="px-3 py-2 bg-purple-100 text-purple-700 rounded-lg hover:bg-purple-200 transition-colors text-sm"
                                    title="選択した音声を試聴">
                                    <i class="fas fa-play"></i>
                                </button>
                            </div>
                            <!-- 試聴オーディオプレーヤー -->
                            <div id="narrationVoicePreviewContainer" class="hidden mt-2 p-2 bg-white rounded-lg border border-purple-200">
                                <div class="flex items-center gap-2">
                                    <audio id="narrationVoicePreviewAudio" controls class="flex-1 h-8"></audio>
                                    <button onclick="stopNarrationPreview()" class="text-xs px-2 py-1 text-red-600 hover:bg-red-50 rounded" title="停止">
                                        <i class="fas fa-stop"></i>
                                    </button>
                                </div>
                                <p id="narrationVoicePreviewStatus" class="text-xs text-gray-500 mt-1"></p>
                            </div>
                            <p class="text-xs text-gray-500 mt-1">
                                <i class="fas fa-info-circle mr-1"></i>
                                キャラクター音声を使いたい場合は、発話を「キャラセリフ」に設定してください。キャラの声は自動で適用されます。
                            </p>
                            <div class="flex items-center justify-between mt-2">
                                <span id="narrationVoiceCurrent" class="text-xs text-gray-500">現在: ja-JP-Neural2-B（フォールバック）</span>
                                <button id="narrationVoiceSaveBtn" onclick="saveNarrationVoice()" 
                                    class="px-3 py-1.5 bg-purple-600 text-white rounded-lg text-xs font-semibold hover:bg-purple-700 transition-colors">
                                    <i class="fas fa-save mr-1"></i>保存
                                </button>
                            </div>
                        </div>
                    </div>
                    
                    <div class="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                        <!-- Status Summary -->
                        <div id="builderStatusSummary" class="text-sm text-gray-600">
                            <!-- Will be populated by JS -->
                        </div>
                        
                        <!-- Note: シーン追加はScene Splitタブで行う（整合性維持のため） -->
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
                                    <!-- BGMフェードイン/アウト設定 -->
                                    <div class="mt-3 pt-3 border-t border-gray-200">
                                        <label class="block text-xs font-semibold text-gray-600 mb-2">
                                            <i class="fas fa-wave-square mr-1 text-indigo-500"></i>フェード設定
                                        </label>
                                        <div class="grid grid-cols-2 gap-3">
                                            <div>
                                                <label class="text-xs text-gray-500">フェードイン</label>
                                                <div class="flex items-center gap-2 mt-1">
                                                    <input id="vbBgmFadeIn" type="range" min="0" max="5000" step="100" value="800"
                                                        class="flex-1 accent-indigo-600" oninput="updateBgmFadeLabel('in')" />
                                                    <span id="vbBgmFadeInLabel" class="text-xs text-gray-700 w-12 text-right">0.8秒</span>
                                                </div>
                                            </div>
                                            <div>
                                                <label class="text-xs text-gray-500">フェードアウト</label>
                                                <div class="flex items-center gap-2 mt-1">
                                                    <input id="vbBgmFadeOut" type="range" min="0" max="5000" step="100" value="800"
                                                        class="flex-1 accent-indigo-600" oninput="updateBgmFadeLabel('out')" />
                                                    <span id="vbBgmFadeOutLabel" class="text-xs text-gray-700 w-12 text-right">0.8秒</span>
                                                </div>
                                            </div>
                                        </div>
                                        <p class="text-xs text-gray-400 mt-1">0秒=即開始/即停止、最大5秒</p>
                                    </div>
                                    <p class="text-xs text-gray-500 mt-1">※ BGMファイル自体の管理はBGM設定で行います</p>
                                </div>
                            </div>
                        </div>

                        <!-- テロップ（PR-5-3a + Phase 1）※字幕とは別 -->
                        <div class="p-4 bg-amber-50/50 rounded-lg border border-amber-200">
                            <div class="flex items-center justify-between mb-3">
                                <label class="text-sm font-semibold text-gray-700 flex items-center gap-2">
                                    <i class="fas fa-font text-amber-600"></i>テロップ
                                    <span class="text-xs font-normal text-gray-500">（画面上テキスト）</span>
                                </label>
                                <label class="inline-flex items-center gap-2 cursor-pointer">
                                    <input id="vbTelopsToggle" type="checkbox" class="w-4 h-4 text-amber-600 rounded" checked />
                                    <span class="text-sm text-gray-700">表示する</span>
                                </label>
                            </div>
                            
                            <!-- Phase 1: テロップスタイル選択 -->
                            <div class="grid grid-cols-2 gap-3 mb-3">
                                <div>
                                    <label class="block text-xs text-gray-600 mb-1">スタイル</label>
                                    <select id="vbTelopStyle"
                                        class="w-full px-2 py-1.5 border border-gray-300 rounded text-sm focus:border-amber-500 focus:ring-1 focus:ring-amber-200">
                                        <option value="outline" selected>アウトライン（標準）</option>
                                        <option value="minimal">ミニマル</option>
                                        <option value="band">帯付き（TV風）</option>
                                        <option value="pop">ポップ（バラエティ風）</option>
                                        <option value="cinematic">シネマティック</option>
                                    </select>
                                </div>
                                <div>
                                    <label class="block text-xs text-gray-600 mb-1">サイズ</label>
                                    <select id="vbTelopSize"
                                        class="w-full px-2 py-1.5 border border-gray-300 rounded text-sm focus:border-amber-500 focus:ring-1 focus:ring-amber-200">
                                        <option value="sm">小</option>
                                        <option value="md" selected>中</option>
                                        <option value="lg">大</option>
                                    </select>
                                </div>
                            </div>
                            <div class="mb-2">
                                <label class="block text-xs text-gray-600 mb-1">表示位置</label>
                                <select id="vbTelopPosition"
                                    class="w-full px-2 py-1.5 border border-gray-300 rounded text-sm focus:border-amber-500 focus:ring-1 focus:ring-amber-200">
                                    <option value="bottom" selected>下</option>
                                    <option value="center">中央</option>
                                    <option value="top">上</option>
                                </select>
                            </div>
                            
                            <!-- テロッププレビュー -->
                            <div class="mt-3 mb-2 p-3 bg-gray-100 rounded-lg border border-gray-300">
                                <label class="block text-xs text-gray-600 mb-2 font-semibold">
                                    <i class="fas fa-eye mr-1 text-amber-600"></i>プレビュー
                                </label>
                                <div id="vbTelopPreviewContainer" class="relative w-full rounded-lg overflow-hidden border-2 border-gray-400" style="height: 120px; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);">
                                    <!-- 映像風の背景装飾 -->
                                    <div class="absolute inset-0 opacity-30">
                                        <div class="absolute top-4 right-8 w-12 h-12 bg-yellow-300 rounded-full"></div>
                                        <div class="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-green-600/50 to-transparent"></div>
                                        <div class="absolute top-1/3 left-1/4 w-16 h-10 bg-green-700/40 rounded-full blur-sm"></div>
                                    </div>
                                    <!-- テロップ表示エリア -->
                                    <div id="vbTelopPreviewText" class="absolute left-1/2 transform -translate-x-1/2 px-4 py-2 max-w-[90%] text-center" style="bottom: 12px;">
                                        <span class="text-white font-semibold" style="font-size: 16px; text-shadow: -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000;">
                                            サンプルテロップ
                                        </span>
                                    </div>
                                </div>
                                <p class="text-xs text-gray-500 mt-2 text-center">
                                    <i class="fas fa-info-circle mr-1"></i>設定を変更するとリアルタイムで反映されます
                                </p>
                            </div>
                            
                            <!-- カスタムスタイル設定（折りたたみ） -->
                            <details class="mt-3 border border-amber-200 rounded-lg overflow-hidden">
                                <summary class="px-3 py-2 bg-amber-50 cursor-pointer text-sm text-amber-700 hover:bg-amber-100 flex items-center gap-2">
                                    <i class="fas fa-sliders-h"></i>
                                    <span>カスタム設定（Vrew風）</span>
                                    <span class="text-xs text-amber-500 ml-auto">クリックで展開</span>
                                </summary>
                                <div class="p-3 bg-white space-y-3">
                                    <!-- 文字色 -->
                                    <div class="grid grid-cols-2 gap-3">
                                        <div>
                                            <label class="block text-xs text-gray-600 mb-1">文字色</label>
                                            <div class="flex gap-2">
                                                <input type="color" id="vbTelopTextColor" value="#FFFFFF" 
                                                    class="w-10 h-8 rounded cursor-pointer border border-gray-300" />
                                                <input type="text" id="vbTelopTextColorHex" value="#FFFFFF" 
                                                    class="flex-1 px-2 py-1 border border-gray-300 rounded text-xs font-mono" 
                                                    placeholder="#FFFFFF" />
                                            </div>
                                        </div>
                                        <div>
                                            <label class="block text-xs text-gray-600 mb-1">縁取り色</label>
                                            <div class="flex gap-2">
                                                <input type="color" id="vbTelopStrokeColor" value="#000000" 
                                                    class="w-10 h-8 rounded cursor-pointer border border-gray-300" />
                                                <input type="text" id="vbTelopStrokeColorHex" value="#000000" 
                                                    class="flex-1 px-2 py-1 border border-gray-300 rounded text-xs font-mono" 
                                                    placeholder="#000000" />
                                            </div>
                                        </div>
                                    </div>
                                    
                                    <!-- 縁取り太さ -->
                                    <div>
                                        <label class="block text-xs text-gray-600 mb-1">縁取りの太さ: <span id="vbTelopStrokeWidthValue">2</span>px</label>
                                        <input type="range" id="vbTelopStrokeWidth" min="0" max="6" step="0.5" value="2" 
                                            class="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-amber-500" />
                                    </div>
                                    
                                    <!-- 背景設定 -->
                                    <div class="grid grid-cols-2 gap-3">
                                        <div>
                                            <label class="block text-xs text-gray-600 mb-1">背景色</label>
                                            <div class="flex gap-2">
                                                <input type="color" id="vbTelopBgColor" value="#000000" 
                                                    class="w-10 h-8 rounded cursor-pointer border border-gray-300" />
                                                <input type="text" id="vbTelopBgColorHex" value="#000000" 
                                                    class="flex-1 px-2 py-1 border border-gray-300 rounded text-xs font-mono" 
                                                    placeholder="#000000" />
                                            </div>
                                        </div>
                                        <div>
                                            <label class="block text-xs text-gray-600 mb-1">背景透過度: <span id="vbTelopBgOpacityValue">0</span>%</label>
                                            <input type="range" id="vbTelopBgOpacity" min="0" max="100" step="5" value="0" 
                                                class="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-amber-500" />
                                        </div>
                                    </div>
                                    
                                    <!-- フォント設定 -->
                                    <div class="grid grid-cols-2 gap-3">
                                        <div>
                                            <label class="block text-xs text-gray-600 mb-1">フォント</label>
                                            <select id="vbTelopFontFamily" 
                                                class="w-full px-2 py-1.5 border border-gray-300 rounded text-sm">
                                                <option value="noto-sans">ゴシック（Noto Sans JP）</option>
                                                <option value="noto-serif">明朝（Noto Serif JP）</option>
                                                <option value="rounded">丸ゴシック（M PLUS Rounded）</option>
                                                <option value="zen-maru">Zen丸ゴシック</option>
                                            </select>
                                        </div>
                                        <div>
                                            <label class="block text-xs text-gray-600 mb-1">太さ</label>
                                            <select id="vbTelopFontWeight" 
                                                class="w-full px-2 py-1.5 border border-gray-300 rounded text-sm">
                                                <option value="400">通常 (400)</option>
                                                <option value="500">中太 (500)</option>
                                                <option value="600" selected>セミボールド (600)</option>
                                                <option value="700">太字 (700)</option>
                                                <option value="800">極太 (800)</option>
                                            </select>
                                        </div>
                                    </div>
                                    
                                    <!-- まるっとムービー-Typography: 文字組み設定 -->
                                    <div class="pt-3 mt-3 border-t border-amber-200">
                                        <div class="flex items-center gap-2 mb-3">
                                            <i class="fas fa-paragraph text-amber-600"></i>
                                            <span class="text-sm font-semibold text-gray-700">文字組み（Typography）</span>
                                        </div>
                                        
                                        <!-- 最大行数・行間 -->
                                        <div class="grid grid-cols-2 gap-3 mb-3">
                                            <div>
                                                <label class="block text-xs text-gray-600 mb-1">最大行数</label>
                                                <select id="vbTelopMaxLines" 
                                                    class="w-full px-2 py-1.5 border border-gray-300 rounded text-sm">
                                                    <option value="1">1行</option>
                                                    <option value="2" selected>2行</option>
                                                    <option value="3">3行</option>
                                                    <option value="4">4行</option>
                                                    <option value="5">5行</option>
                                                    <option value="6">6行</option>
                                                </select>
                                            </div>
                                            <div>
                                                <label class="block text-xs text-gray-600 mb-1">行間: <span id="vbTelopLineHeightValue">140</span>%</label>
                                                <input type="range" id="vbTelopLineHeight" min="100" max="200" step="10" value="140" 
                                                    class="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-amber-500" />
                                            </div>
                                        </div>
                                        
                                        <!-- 文字間・超過時 -->
                                        <div class="grid grid-cols-2 gap-3">
                                            <div>
                                                <label class="block text-xs text-gray-600 mb-1">文字間: <span id="vbTelopLetterSpacingValue">0</span>px</label>
                                                <input type="range" id="vbTelopLetterSpacing" min="-2" max="6" step="0.5" value="0" 
                                                    class="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-amber-500" />
                                            </div>
                                            <div>
                                                <label class="block text-xs text-gray-600 mb-1">超過時</label>
                                                <select id="vbTelopOverflowMode" 
                                                    class="w-full px-2 py-1.5 border border-gray-300 rounded text-sm">
                                                    <option value="truncate" selected>省略（...）</option>
                                                    <option value="shrink">縮小</option>
                                                </select>
                                            </div>
                                        </div>
                                    </div>
                                    
                                    <!-- プリセットに戻すボタン -->
                                    <div class="pt-2 border-t border-gray-200">
                                        <button type="button" id="vbTelopResetCustom" 
                                            class="w-full px-3 py-1.5 text-xs text-gray-600 bg-gray-100 hover:bg-gray-200 rounded transition-colors">
                                            <i class="fas fa-undo mr-1"></i>プリセットのデフォルトに戻す
                                        </button>
                                    </div>
                                    
                                    <p class="text-xs text-gray-500">
                                        <i class="fas fa-info-circle text-amber-500 mr-1"></i>
                                        カスタム設定はプリセットより優先されます。<br/>
                                        縁取り0pxで影のみ、背景透過0%で透明になります。
                                    </p>
                                </div>
                            </details>
                            
                            <!-- Telop-DefaultSave: 保存トグル -->
                            <div class="mt-3 pt-3 border-t border-amber-200">
                                <label class="flex items-center gap-2 cursor-pointer">
                                    <input type="checkbox" id="vbTelopSaveDefault" checked
                                        class="w-4 h-4 text-amber-600 bg-gray-100 border-gray-300 rounded focus:ring-amber-500" />
                                    <span class="text-sm text-gray-700">この設定を今後のデフォルトとして保存</span>
                                </label>
                                <p class="text-xs text-gray-500 mt-1 ml-6">
                                    <i class="fas fa-save text-amber-500 mr-1"></i>
                                    ONにすると、次回のVideo Buildで自動的にこの設定が適用されます
                                </p>
                            </div>
                            
                            <p class="text-xs text-gray-500 mt-2">
                                <i class="fas fa-info-circle text-amber-500 mr-1"></i>
                                テロップ＝シーンごとの任意テキスト表現。<br/>
                                字幕（CC）＝音声由来の自動字幕。両方同時ONも可能です。
                            </p>
                        </div>

                        <!-- Phase2-1: 漫画の文字（焼き込み）設定 ※保存のみ、反映は再生成が必要 -->
                        <!-- Phase1-1: display_asset_type !== 'comic' のシーンのみの場合は非表示 -->
                        <div id="comicTelopSection" class="p-4 bg-rose-50/50 rounded-lg border border-rose-200" style="display: none;">
                            <div class="flex items-center justify-between mb-3">
                                <label class="text-sm font-semibold text-gray-700 flex items-center gap-2">
                                    <i class="fas fa-image text-rose-600"></i>漫画の文字（焼き込み）
                                    <span class="text-xs font-normal text-gray-500">（画像に焼き込むテキスト）</span>
                                </label>
                            </div>
                            
                            <!-- 注意書き（常時表示） -->
                            <div class="mb-3 p-2 bg-amber-100 border border-amber-300 rounded text-xs text-amber-800">
                                <i class="fas fa-exclamation-triangle mr-1"></i>
                                <strong>注意:</strong> この設定は「次回の漫画生成」から反映されます。既に作成済みの漫画画像は変わりません（再生成が必要）。
                            </div>
                            
                            <!-- スタイル・サイズ選択 -->
                            <div class="grid grid-cols-2 gap-3 mb-3">
                                <div>
                                    <label class="block text-xs text-gray-600 mb-1">スタイル</label>
                                    <select id="vbComicTelopStyle"
                                        class="w-full px-2 py-1.5 border border-gray-300 rounded text-sm focus:border-rose-500 focus:ring-1 focus:ring-rose-200">
                                        <option value="outline" selected>アウトライン（標準）</option>
                                        <option value="minimal">ミニマル</option>
                                        <option value="band">帯付き（TV風）</option>
                                        <option value="pop">ポップ（バラエティ風）</option>
                                        <option value="cinematic">シネマティック</option>
                                    </select>
                                </div>
                                <div>
                                    <label class="block text-xs text-gray-600 mb-1">サイズ</label>
                                    <select id="vbComicTelopSize"
                                        class="w-full px-2 py-1.5 border border-gray-300 rounded text-sm focus:border-rose-500 focus:ring-1 focus:ring-rose-200">
                                        <option value="sm">小</option>
                                        <option value="md" selected>中</option>
                                        <option value="lg">大</option>
                                    </select>
                                </div>
                            </div>
                            <div class="mb-2">
                                <label class="block text-xs text-gray-600 mb-1">表示位置</label>
                                <select id="vbComicTelopPosition"
                                    class="w-full px-2 py-1.5 border border-gray-300 rounded text-sm focus:border-rose-500 focus:ring-1 focus:ring-rose-200">
                                    <option value="bottom" selected>下</option>
                                    <option value="center">中央</option>
                                    <option value="top">上</option>
                                </select>
                            </div>
                            
                            <p class="text-xs text-gray-500 mt-2">
                                <i class="fas fa-info-circle text-rose-500 mr-1"></i>
                                上記「テロップ」はまるっとムービー動画用。この「漫画の文字」は漫画画像に焼き込むスタイルです。
                            </p>
                            
                            <!-- 保存ボタン -->
                            <button 
                                onclick="saveComicTelopSettings()"
                                class="mt-3 w-full px-3 py-2 bg-rose-600 text-white rounded-lg hover:bg-rose-700 transition-colors text-sm font-medium flex items-center justify-center gap-2"
                            >
                                <i class="fas fa-save"></i>設定を保存
                            </button>
                            
                            <!-- PR-Comic-Rebake-All: 全シーン一括反映予約ボタン -->
                            <div class="mt-3 pt-3 border-t border-rose-200">
                                <button 
                                    id="btnBulkRebakeComic"
                                    onclick="openBulkRebakeModal()"
                                    class="w-full px-3 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition-colors text-sm font-medium flex items-center justify-center gap-2"
                                    title="保存済みの設定を全ての漫画シーンに適用予約します"
                                >
                                    <i class="fas fa-sync-alt"></i>この設定を全シーンに反映予約
                                </button>
                                <p class="text-xs text-gray-500 mt-1 text-center">
                                    <i class="fas fa-info-circle text-amber-500 mr-1"></i>
                                    AI画像は変わりません。各シーンの「公開」時に新設定で再焼き込みされます。
                                </p>
                            </div>
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
                                <option value="kenburns_strong">強めズーム</option>
                                <option value="kenburns_zoom_out">ズームアウト</option>
                                <option value="pan_lr">パン（左→右）</option>
                                <option value="pan_rl">パン（右→左）</option>
                                <option value="pan_tb">パン（上→下）</option>
                                <option value="pan_bt">パン（下→上）</option>
                                <option value="slide_lr">スライド（左→右）</option>
                                <option value="slide_rl">スライド（右→左）</option>
                                <option value="slide_tb">スライド（上→下）</option>
                                <option value="slide_bt">スライド（下→上）</option>
                                <option value="hold_then_slide_lr">静止→スライド（左→右）</option>
                                <option value="hold_then_slide_rl">静止→スライド（右→左）</option>
                                <option value="combined_zoom_pan_lr">ズーム＋パン（左→右）</option>
                                <option value="combined_zoom_pan_rl">ズーム＋パン（右→左）</option>
                                <option value="auto">自動（シード基準）</option>
                            </select>
                            <p class="text-xs text-gray-500 mt-1">
                                画像シーンにカメラワーク的な動きを付けます
                            </p>
                            <!-- Phase B-2: 全シーン一括適用ボタン -->
                            <div class="mt-2 flex items-center gap-2">
                                <button type="button" 
                                    id="vbMotionApplyAll"
                                    onclick="applyMotionToAllScenes()"
                                    class="px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors flex items-center gap-1">
                                    <i class="fas fa-layer-group"></i>全シーンに適用
                                </button>
                                <span id="vbMotionApplyStatus" class="text-xs text-gray-500 hidden"></span>
                            </div>
                        </div>

                        <!-- トランジション（シーン切り替え効果） -->
                        <div>
                            <label class="block text-sm font-semibold text-gray-700 mb-2">
                                <i class="fas fa-exchange-alt mr-1 text-teal-600"></i>トランジション（シーン切り替え効果）
                            </label>
                            <select id="vbTransitionType"
                                class="w-full px-3 py-2 border-2 border-gray-300 rounded-lg focus:border-teal-500 focus:ring-2 focus:ring-teal-200 text-sm">
                                <option value="fade" selected>フェイド（ふわっと切り替え）</option>
                                <option value="none">なし（パッと切り替え）</option>
                            </select>
                            <p class="text-xs text-gray-500 mt-1">
                                各シーンの切り替え時のフェイドイン/フェイドアウト効果を設定します
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
                        <div class="text-right">
                            <span id="videoBuildProgressPercent" class="text-2xl font-bold text-blue-600">0%</span>
                            <div id="videoBuildProgressEta" class="text-sm text-gray-500 mt-1">残り時間を計算中...</div>
                        </div>
                    </div>
                    
                    <!-- Progress Bar -->
                    <div class="w-full bg-gray-200 rounded-full h-4 mb-3 overflow-hidden">
                        <div id="videoBuildProgressBar" class="h-full bg-gradient-to-r from-purple-500 to-blue-500 transition-all duration-500 ease-out" style="width: 0%"></div>
                    </div>
                    
                    <div class="flex items-center justify-between text-sm">
                        <span id="videoBuildProgressStage" class="text-gray-600">準備中...</span>
                        <span id="videoBuildProgressId" class="text-gray-400 font-mono text-xs"></span>
                    </div>
                    
                    <!-- Additional Info -->
                    <div id="videoBuildProgressInfo" class="mt-3 pt-3 border-t border-gray-200 text-xs text-gray-500">
                        <span id="videoBuildProgressElapsed">経過時間: 計算中...</span>
                        <span class="mx-2">|</span>
                        <span id="videoBuildProgressDuration">推定総時間: 計算中...</span>
                    </div>
                    
                    <!-- User Note -->
                    <div class="mt-3 p-3 bg-blue-50 rounded-lg text-sm text-blue-700">
                        <i class="fas fa-info-circle mr-2"></i>
                        このページを閉じても、動画生成はバックグラウンドで継続されます。完了後、履歴からダウンロードできます。
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
                            <!-- Phase 2-1 + A-3: モーション系（全プリセット対応） -->
                            <div class="mb-2">
                                <div class="text-xs text-gray-500 mb-1">🎬 モーション（カメラの動き）</div>
                                <!-- ズーム＆パン基本 -->
                                <div class="flex flex-wrap gap-1.5 mb-1">
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100"
                                        onclick="insertChatTemplate('シーン{scene}のモーションをゆっくりズームにして')">
                                        ゆっくりズーム
                                    </button>
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100"
                                        onclick="insertChatTemplate('シーン{scene}のモーションを強めズームにして')">
                                        強めズーム
                                    </button>
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100"
                                        onclick="insertChatTemplate('シーン{scene}のモーションをズームアウトにして')">
                                        ズームアウト
                                    </button>
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100"
                                        onclick="insertChatTemplate('シーン{scene}のモーションを左から右にパンして')">
                                        左→右パン
                                    </button>
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100"
                                        onclick="insertChatTemplate('シーン{scene}のモーションを右から左にパンして')">
                                        右→左パン
                                    </button>
                                </div>
                                <!-- スライド＆複合＆特殊 -->
                                <div class="flex flex-wrap gap-1.5 mb-1">
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-cyan-50 text-cyan-700 border border-cyan-200 hover:bg-cyan-100"
                                        onclick="insertChatTemplate('シーン{scene}のモーションを左から右にスライドして')">
                                        スライド左→右
                                    </button>
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-cyan-50 text-cyan-700 border border-cyan-200 hover:bg-cyan-100"
                                        onclick="insertChatTemplate('シーン{scene}のモーションを右から左にスライドして')">
                                        スライド右→左
                                    </button>
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-teal-50 text-teal-700 border border-teal-200 hover:bg-teal-100"
                                        onclick="insertChatTemplate('シーン{scene}のモーションを静止してから右にスライドして')">
                                        静止→右へ
                                    </button>
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-purple-50 text-purple-700 border border-purple-200 hover:bg-purple-100"
                                        onclick="insertChatTemplate('シーン{scene}のモーションをズーム＋右パンにして')">
                                        ズーム+右パン
                                    </button>
                                </div>
                                <!-- 一括系＆自動 -->
                                <div class="flex flex-wrap gap-1.5">
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-yellow-50 text-yellow-700 border border-yellow-200 hover:bg-yellow-100"
                                        onclick="insertChatTemplate('全シーンのモーションを自動（ランダム）にして')">
                                        全シーン自動
                                    </button>
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100"
                                        onclick="insertChatTemplate('シーン{scene}の動きを止めて')">
                                        動きなし
                                    </button>
                                </div>
                            </div>
                            <!-- Phase 2-2: カスタムスタイル系 -->
                            <div class="mb-2">
                                <div class="text-xs text-gray-500 mb-1">🎨 カスタムスタイル（Vrew風）</div>
                                <div class="flex flex-wrap gap-1.5">
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-pink-50 text-pink-700 border border-pink-200 hover:bg-pink-100"
                                        onclick="insertChatTemplate('テロップの文字色を黄色にして')">
                                        文字色：黄色
                                    </button>
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-pink-50 text-pink-700 border border-pink-200 hover:bg-pink-100"
                                        onclick="insertChatTemplate('テロップを白文字に黒い縁取りにして')">
                                        白文字＋黒縁取り
                                    </button>
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-pink-50 text-pink-700 border border-pink-200 hover:bg-pink-100"
                                        onclick="insertChatTemplate('フォントを明朝体に変えて')">
                                        明朝体
                                    </button>
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-pink-50 text-pink-700 border border-pink-200 hover:bg-pink-100"
                                        onclick="insertChatTemplate('フォントを丸ゴシックに変えて')">
                                        丸ゴシック
                                    </button>
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-pink-50 text-pink-700 border border-pink-200 hover:bg-pink-100"
                                        onclick="insertChatTemplate('テロップをもっと太くして')">
                                        文字を太く
                                    </button>
                                    <button type="button"
                                        class="px-2.5 py-1 text-xs rounded-full bg-pink-50 text-pink-700 border border-pink-200 hover:bg-pink-100"
                                        onclick="insertChatTemplate('テロップの縁取りを消して')">
                                        縁取りなし
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
                    
                    <!-- ================================================ -->
                    <!-- タブナビゲーション（最上部に配置） -->
                    <!-- ================================================ -->
                    <div id="scene-edit-tabs">
                        <!-- Dynamically populated -->
                    </div>
                    
                    <!-- Tab A: Character Assignment -->
                    <div id="scene-edit-tab-characters" class="space-y-4">
                        <!-- Dynamically populated -->
                    </div>
                    
                    <!-- Tab B: Utterances (音声タブ) -->
                    <div id="scene-edit-tab-utterances" class="hidden space-y-4">
                        <!-- Dynamically populated by UtterancesTab -->
                    </div>
                    
                    <!-- Tab C: Character Traits -->
                    <div id="scene-edit-tab-traits" class="hidden space-y-4">
                        <!-- Dynamically populated -->
                    </div>
                    
                    <!-- Tab D: SFX -->
                    <div id="scene-edit-tab-sfx" class="hidden space-y-4">
                        <!-- Dynamically populated by scene-edit-modal.js -->
                    </div>
                    
                    <!-- Tab E: BGM -->
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
                    
                    <!-- ================================================ -->
                    <!-- モーション設定・シーン尺（タブの下に配置） -->
                    <!-- ================================================ -->
                    <div class="space-y-4 pt-4 border-t border-gray-200">
                        <!-- モーション設定 -->
                        <div id="motion-selector-container">
                            <div class="animate-pulse p-4 border border-gray-200 rounded-lg bg-gray-50">
                                <div class="h-4 bg-gray-200 rounded w-1/4 mb-2"></div>
                                <div class="h-10 bg-gray-200 rounded"></div>
                            </div>
                        </div>
                        
                        <!-- シーン尺設定 -->
                        <div id="duration-override-container">
                            <!-- Dynamically populated by scene-edit-modal.js -->
                        </div>
                    </div>
                    
                    <!-- ================================================ -->
                    <!-- 最終レンダリング結果（折りたたみ・最下部） -->
                    <!-- ================================================ -->
                    <details class="border border-gray-200 rounded-lg bg-gray-50">
                        <summary class="px-4 py-3 cursor-pointer text-sm font-semibold text-gray-600 hover:bg-gray-100 select-none">
                            <i class="fas fa-eye mr-2"></i>最終出力プレビュー（クリックで展開）
                        </summary>
                        <div class="px-4 pb-4">
                            <div id="rendering-preview-container">
                                <!-- Dynamically populated by scene-edit-modal.js -->
                            </div>
                        </div>
                    </details>
                    
                    <!-- セリフ・画像プロンプト: ビルダーで直接編集するため非表示 -->
                    <input type="hidden" id="edit-dialogue" />
                    <input type="hidden" id="edit-image-prompt" />
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
    <title>ログイン - MARUMUVI</title>
    <link rel="icon" type="image/svg+xml" href="/static/favicon.svg">
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
</head>
<body class="bg-gradient-to-br from-blue-50 to-purple-50 min-h-screen flex items-center justify-center p-4">
    <div class="bg-white rounded-2xl shadow-xl max-w-md w-full p-8">
        <div class="text-center mb-8">
            <i class="fas fa-video text-5xl text-blue-600 mb-4"></i>
            <h1 class="text-2xl font-bold text-gray-800">MARUMUVI</h1>
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
    <title>新規登録 - MARUMUVI</title>
    <link rel="icon" type="image/svg+xml" href="/static/favicon.svg">
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
</head>
<body class="bg-gradient-to-br from-blue-50 to-purple-50 min-h-screen flex items-center justify-center p-4">
    <div class="bg-white rounded-2xl shadow-xl max-w-md w-full p-8">
        <div class="text-center mb-8">
            <i class="fas fa-video text-5xl text-blue-600 mb-4"></i>
            <h1 class="text-2xl font-bold text-gray-800">MARUMUVI</h1>
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
    <title>パスワードリセット - MARUMUVI</title>
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
    <title>新しいパスワード設定 - MARUMUVI</title>
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
  c.header('Cache-Control', 'no-cache, no-store, must-revalidate')
  c.header('Pragma', 'no-cache')
  c.header('Expires', '0')
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
    <title>新規登録 - MARUMUVI</title>
    <link rel="icon" type="image/svg+xml" href="/static/favicon.svg">
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
</head>
<body class="bg-gradient-to-br from-green-50 to-teal-100 min-h-screen flex items-center justify-center p-4">
    <div class="bg-white rounded-2xl shadow-xl w-full max-w-md p-8">
        <div class="text-center mb-8">
            <h1 class="text-2xl font-bold text-gray-800">
                <i class="fas fa-film text-green-600 mr-2"></i>
                MARUMUVI
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

// ============================================================
// Marunage Dashboard - 丸投げ一覧画面
// ============================================================
app.get('/marunage', (c) => {
  const ASSET_VERSION = getAssetVersion(c.env)
  return c.html(`
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>丸投げチャット - MARUMUVI</title>
    <link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Kaku Gothic ProN', sans-serif; background: #fafafa; min-height: 100vh; }
      .card-item { transition: all 0.22s cubic-bezier(.4,0,.2,1); }
      .card-item:hover { transform: translateY(-3px); box-shadow: 0 12px 32px rgba(0,0,0,0.08); }
      .fade-in { animation: fadeIn 0.35s ease forwards; opacity: 0; }
      @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
      .pulse-dot { animation: pulse 2s ease-in-out infinite; }
      @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
      .action-btn { opacity: 0; transition: opacity 0.15s; }
      .card-item:hover .action-btn { opacity: 1; }
      .nav-icon { width: 36px; height: 36px; border-radius: 10px; display: flex; align-items: center; justify-content: center; transition: all 0.15s; color: #9ca3af; }
      .nav-icon:hover { background: #f3f4f6; color: #374151; }
      .nav-icon.active { background: #111827; color: white; }
      .input-card { transition: box-shadow 0.25s ease; }
      .input-card:hover { box-shadow: 0 6px 20px rgba(0,0,0,0.06); }
      .scroll-row { scrollbar-width: none; -ms-overflow-style: none; }
      .scroll-row::-webkit-scrollbar { display: none; }
    </style>
</head>
<body>
    <!-- Auth Loading -->
    <div id="mgAuthLoading" class="flex items-center justify-center min-h-screen">
      <div class="text-center">
        <div class="w-8 h-8 border-2 border-gray-200 border-t-gray-800 rounded-full animate-spin mx-auto mb-3"></div>
        <p class="text-gray-400 text-xs">読み込み中</p>
      </div>
    </div>

    <!-- Main Layout -->
    <div id="mgMain" class="hidden min-h-screen flex">
      <!-- Left Sidebar -->
      <aside class="w-14 bg-white border-r border-gray-100/80 flex flex-col items-center py-5 gap-2 shrink-0 sticky top-0 h-screen">
        <a href="/" class="nav-icon mb-3" title="ホーム">
          <i class="fas fa-th-large text-xs"></i>
        </a>
        <div class="nav-icon active" title="丸投げチャット">
          <i class="fas fa-magic text-xs"></i>
        </div>
        <a href="/" class="nav-icon" title="プロジェクト一覧">
          <i class="fas fa-folder text-xs"></i>
        </a>
        <div class="flex-1"></div>
        <a href="/settings" class="nav-icon" title="設定">
          <i class="fas fa-cog text-xs"></i>
        </a>
      </aside>

      <!-- Main Content -->
      <main class="flex-1 min-w-0">

        <!-- ===== Hero: centered title + input card ===== -->
        <div class="bg-white border-b border-gray-100/60">
          <div class="max-w-3xl mx-auto px-8 pt-14 pb-10">
            <div class="text-center mb-8">
              <h1 class="text-3xl font-bold text-gray-900 tracking-tight">丸投げチャット</h1>
              <p class="text-sm text-gray-400 mt-2">シナリオを貼るだけで画像・音声・BGM・動画まで自動生成。チャットで編集指示もOK</p>
            </div>

            <!-- Input-style CTA (Lovart) -->
            <a href="/marunage-chat" id="mgNewCard" class="input-card block bg-white border border-gray-200 rounded-2xl shadow-sm p-4 hover:no-underline">
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center shrink-0">
                  <i class="fas fa-pen text-gray-400 text-sm"></i>
                </div>
                <div class="flex-1 min-w-0 text-left">
                  <div class="text-sm text-gray-400">シナリオを貼り付けて動画を作る</div>
                  <div class="text-xs text-gray-300 mt-0.5">例）「朝の東京を紹介するVlog」</div>
                </div>
                <div class="w-9 h-9 rounded-full bg-gray-900 flex items-center justify-center shrink-0">
                  <i class="fas fa-arrow-right text-white text-xs"></i>
                </div>
              </div>
            </a>
          </div>
        </div>

        <!-- ===== Recent Projects: horizontal scroll ===== -->
        <div class="py-8 px-8">
          <div class="max-w-6xl mx-auto">
            <!-- Section Header -->
            <div class="flex items-center justify-between mb-5">
              <div class="flex items-center gap-3">
                <h2 id="mgSectionLabel" class="text-sm font-bold text-gray-700">最近のプロジェクト</h2>
                <span id="mgCount" class="text-[11px] text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full"></span>
              </div>
              <div class="flex items-center gap-1 bg-gray-100 rounded-lg p-0.5">
                <button id="mgFilterActive" onclick="mgSetFilter('active')" class="px-3 py-1.5 text-xs font-semibold rounded-md bg-white text-gray-800 shadow-sm transition-all">アクティブ</button>
                <button id="mgFilterArchived" onclick="mgSetFilter('archived')" class="px-3 py-1.5 text-xs font-semibold rounded-md text-gray-400 transition-all">アーカイブ</button>
              </div>
            </div>

            <!-- Scroll Row -->
            <div id="mgGrid" class="scroll-row flex gap-4 overflow-x-auto pb-4">
              <div class="flex-1 text-center py-16">
                <div class="w-8 h-8 border-2 border-gray-200 border-t-gray-400 rounded-full animate-spin mx-auto mb-3"></div>
                <p class="text-xs text-gray-300">読み込み中</p>
              </div>
            </div>
          </div>
        </div>

      </main>

      </div>

    <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
    <script>
      axios.defaults.withCredentials = true;
      var mgCurrentFilter = 'active';

      // ── 6-step config ──
      var STEPS = ['整形','確認','画像','音声','動画','完了'];

      function mgGetStepInfo(r) {
        var p = r.phase;
        if (p === 'failed' || p === 'canceled') {
          if (r.video_build_id) return { step: 4, failed: true };
          if (r.audio_done > 0) return { step: 3, failed: true };
          if (r.images_done > 0) return { step: 2, failed: true };
          if (r.scene_count > 0) return { step: 1, failed: true };
          return { step: 0, failed: true };
        }
        if (p === 'init' || p === 'formatting') return { step: 0, failed: false };
        if (p === 'awaiting_ready') return { step: 1, failed: false };
        if (p === 'generating_images') return { step: 2, failed: false };
        if (p === 'generating_audio') return { step: 3, failed: false };
        if (p === 'ready') {
          if (!r.video_build_id) return { step: 4, failed: false };
          var vs = r.video_build_status;
          if (vs === 'completed') return { step: 5, failed: false };
          if (vs === 'failed') return { step: 4, failed: true };
          return { step: 4, failed: false };
        }
        return { step: 0, failed: false };
      }

      function mgRender6Steps(r) {
        var info = mgGetStepInfo(r);
        var s = info.step, f = info.failed;
        var html = '<div class="flex gap-1 mt-3">';
        for (var i = 0; i < 6; i++) {
          var c = 'bg-gray-100';
          if (f && i === s) c = 'bg-red-300';
          else if (i < s) c = 'bg-emerald-400';
          else if (i === s) c = f ? 'bg-red-300' : 'bg-gray-900';
          html += '<div class="h-1 rounded-full flex-1 ' + c + '"></div>';
        }
        html += '</div>';
        var label = s >= 5 ? '完了' : STEPS[s] + (f ? '（エラー）' : '');
        html += '<div class="flex items-center justify-between mt-1.5">';
        html += '<span class="text-[10px] text-gray-300">' + label + '</span>';
        html += '<span class="text-[10px] text-gray-300">' + Math.min(s, 5) + '/6</span>';
        html += '</div>';
        return html;
      }

      // ── Phase chip ──
      var PH = {
        'init':              { l: '準備中',   bg: 'bg-gray-100',   tx: 'text-gray-500' },
        'formatting':        { l: '整形中',   bg: 'bg-blue-50',    tx: 'text-blue-500' },
        'awaiting_ready':    { l: '確認待ち', bg: 'bg-amber-50',   tx: 'text-amber-600' },
        'generating_images': { l: '画像生成', bg: 'bg-purple-50',  tx: 'text-purple-500' },
        'generating_audio':  { l: '音声生成', bg: 'bg-indigo-50',  tx: 'text-indigo-500' },
        'ready':             { l: '完成',     bg: 'bg-emerald-50', tx: 'text-emerald-600' },
        'failed':            { l: 'エラー',   bg: 'bg-red-50',     tx: 'text-red-500' },
        'canceled':          { l: '中断',     bg: 'bg-gray-50',    tx: 'text-gray-400' },
      };

      function mgSetFilter(f) {
        mgCurrentFilter = f;
        var a = document.getElementById('mgFilterActive');
        var b = document.getElementById('mgFilterArchived');
        a.className = 'px-3 py-1.5 text-xs font-semibold rounded-md transition-all ' + (f === 'active' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-400');
        b.className = 'px-3 py-1.5 text-xs font-semibold rounded-md transition-all ' + (f === 'archived' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-400');
        document.getElementById('mgNewCard').style.display = f === 'archived' ? 'none' : '';
        document.getElementById('mgSectionLabel').textContent = f === 'archived' ? 'アーカイブ済み' : '最近のプロジェクト';
        mgLoadRuns();
      }

      async function mgInit() {
        try {
          var auth = await axios.get('/api/auth/me');
          if (!auth.data.authenticated) { location.href = '/login'; return; }
        } catch(e) { location.href = '/login'; return; }
        document.getElementById('mgAuthLoading').classList.add('hidden');
        document.getElementById('mgMain').classList.remove('hidden');
        await mgLoadRuns();
      }

      async function mgLoadRuns() {
        try {
          var archived = mgCurrentFilter === 'archived' ? '1' : '0';
          var res = await axios.get('/api/marunage/runs?archived=' + archived);
          var runs = res.data.runs || [];
          var grid = document.getElementById('mgGrid');
          document.getElementById('mgCount').textContent = runs.length + '件';

          if (runs.length === 0) {
            grid.innerHTML = '<div class="flex-1 text-center py-20">'
              + '<div class="w-14 h-14 bg-gray-50 rounded-2xl flex items-center justify-center mx-auto mb-3">'
              + '<i class="fas ' + (mgCurrentFilter === 'archived' ? 'fa-archive' : 'fa-inbox') + ' text-xl text-gray-300"></i>'
              + '</div>'
              + '<p class="text-gray-400 text-sm">' + (mgCurrentFilter === 'archived' ? 'アーカイブはありません' : 'プロジェクトはまだありません') + '</p>'
              + '</div>';
            return;
          }

          grid.innerHTML = runs.map(function(r, i) { return mgCard(r, i); }).join('');
        } catch (err) {
          console.error('Load failed:', err);
          document.getElementById('mgGrid').innerHTML = '<div class="flex-1 text-center py-12"><p class="text-red-400 text-sm">読み込みに失敗しました</p></div>';
        }
      }

      function mgCard(r, idx) {
        var ph = PH[r.phase] || { l: r.phase, bg: 'bg-gray-100', tx: 'text-gray-500' };
        var date = mgDate(r.updated_at || r.created_at);
        var href = '/marunage-chat?run=' + r.run_id;

        // Thumbnail
        var thumb = r.first_image_url
          ? '<img src="' + r.first_image_url + '" alt="" class="w-full h-full object-cover" onerror="mgThumbErr(this)">'
          : '<div class="w-full h-full bg-gradient-to-br from-gray-50 to-gray-100 flex items-center justify-center"><i class="fas fa-film text-2xl text-gray-200"></i></div>';

        // Chip
        var chip = '<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ' + ph.bg + ' ' + ph.tx + '">'
          + (r.is_active ? '<span class="w-1 h-1 rounded-full bg-current pulse-dot"></span>' : '')
          + ph.l + '</span>';

        // Action buttons (archive/cancel)
        var actions = '';
        if (mgCurrentFilter === 'archived') {
          actions = '<button onclick="event.preventDefault();event.stopPropagation();mgUnarchive(' + r.run_id + ')" class="action-btn absolute top-2 right-2 w-7 h-7 rounded-lg bg-white/90 shadow-sm border border-gray-100 flex items-center justify-center text-blue-400 hover:text-blue-600 z-10" title="復元"><i class="fas fa-undo text-[10px]"></i></button>';
        } else {
          actions = '<button onclick="event.preventDefault();event.stopPropagation();mgArchive(' + r.run_id + ')" class="action-btn absolute top-2 right-2 w-7 h-7 rounded-lg bg-white/90 shadow-sm border border-gray-100 flex items-center justify-center text-gray-300 hover:text-red-400 z-10" title="非表示"><i class="fas fa-eye-slash text-[10px]"></i></button>';
        }
        if (r.is_active) {
          actions += '<button onclick="event.preventDefault();event.stopPropagation();mgCancel(' + r.project_id + ')" class="action-btn absolute top-2 ' + (mgCurrentFilter === 'archived' ? 'right-10' : 'right-10') + ' w-7 h-7 rounded-lg bg-white/90 shadow-sm border border-gray-100 flex items-center justify-center text-gray-300 hover:text-red-400 z-10" title="中断"><i class="fas fa-stop text-[10px]"></i></button>';
        }

        return '<a href="' + href + '" class="card-item fade-in block w-[260px] shrink-0 relative hover:no-underline" style="animation-delay:' + (idx * 50) + 'ms">'
          + actions
          + '<div class="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">'
          + '<div class="aspect-[16/10] bg-gray-50 overflow-hidden">' + thumb + '</div>'
          + '<div class="p-3.5">'
          + '<div class="flex items-start justify-between gap-2">'
          + '<h3 class="text-[13px] font-semibold text-gray-900 truncate flex-1">' + mgEsc(r.project_title || '無題') + '</h3>'
          + chip
          + '</div>'
          + '<p class="text-[11px] text-gray-400 mt-1">' + date + '</p>'
          + (r.error_message ? '<p class="text-[10px] text-red-400 mt-1 truncate">' + mgEsc(r.error_message.substring(0, 60)) + '</p>' : '')
          + mgRender6Steps(r)
          + '</div>'
          + '</div>'
          + '</a>';
      }

      function mgDate(s) {
        if (!s) return '';
        var d = new Date(s + 'Z'), now = new Date(), ms = now - d;
        var h = Math.floor(ms / 3600000);
        if (h < 1) return Math.max(1, Math.floor(ms / 60000)) + '分前';
        if (h < 24) return h + '時間前';
        var dd = Math.floor(h / 24);
        if (dd < 7) return dd + '日前';
        return d.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' });
      }

      async function mgArchive(id) {
        try { await axios.post('/api/marunage/runs/' + id + '/archive'); await mgLoadRuns(); }
        catch(e) { alert('失敗: ' + (e.response?.data?.error?.message || e.message)); }
      }
      async function mgUnarchive(id) {
        try { await axios.post('/api/marunage/runs/' + id + '/unarchive'); await mgLoadRuns(); }
        catch(e) { alert('失敗: ' + (e.response?.data?.error?.message || e.message)); }
      }
      async function mgCancel(pid) {
        if (!confirm('この処理を中断しますか？')) return;
        try { await axios.post('/api/marunage/' + pid + '/cancel'); await mgLoadRuns(); }
        catch(e) { alert('失敗: ' + (e.response?.data?.error?.message || e.message)); }
      }
      function mgEsc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
      function mgThumbErr(img) { var p = img.parentElement; p.innerHTML = '<div class="w-full h-full bg-gradient-to-br from-gray-50 to-gray-100 flex items-center justify-center"><i class="fas fa-film text-2xl text-gray-200"></i></div>'; }

      // ── Auto-refresh (30s) ──
      setInterval(function() { mgLoadRuns(); }, 30000);

      mgInit();
    </script>
</body>
</html>
  `)
})

// ============================================================
// Marunage Chat MVP - 体験C 専用エントリ
// Ref: docs/MARUNAGE_EXPERIENCE_SPEC_v1.md
// ============================================================
app.get('/marunage-chat', (c) => {
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
    <title>丸投げチャット - MARUMUVI</title>
    <link rel="icon" type="image/svg+xml" href="/static/favicon.svg">
    <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        * { -webkit-tap-highlight-color: rgba(0,0,0,0); box-sizing: border-box; }
        body { overscroll-behavior: none; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
        
        /* ===== 2-column layout ===== */
        .mc-shell { display: flex; height: 100vh; overflow: hidden; }
        .mc-left  { flex: 1; min-width: 0; display: flex; flex-direction: column; border-right: 1px solid #e5e7eb; background: #f9fafb; }
        .mc-right { width: 420px; min-width: 360px; display: flex; flex-direction: column; background: #fff; }
        
        /* Mobile: stacked with toggle */
        @media (max-width: 768px) {
            .mc-shell { flex-direction: column; }
            .mc-left  { border-right: none; border-bottom: 1px solid #e5e7eb; height: 50vh; }
            .mc-right { width: 100%; height: 50vh; min-width: unset; }
            .mc-left.mc-expanded  { height: 85vh; }
            .mc-right.mc-expanded { height: 85vh; }
        }
        
        /* ===== Chat bubbles ===== */
        .chat-bubble { max-width: 85%; padding: 0.75rem 1rem; border-radius: 1rem; line-height: 1.6; font-size: 0.9rem; word-break: break-word; }
        .chat-system { background: #f3f0ff; color: #4c1d95; border-bottom-left-radius: 0.25rem; }
        .chat-user   { background: #3b82f6; color: #fff; margin-left: auto; border-bottom-right-radius: 0.25rem; }
        
        /* ===== Scene cards ===== */
        .scene-card { background: #fff; border-radius: 0.75rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); overflow: hidden; transition: all 0.3s; }
        .scene-card:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
        .scene-card-img { width: 100%; aspect-ratio: 16/9; object-fit: cover; background: #e5e7eb; }
        div.scene-card-img { display: flex; align-items: center; justify-content: center; }
        img.scene-card-img { display: block; }
        .scene-badge { display: inline-flex; align-items: center; padding: 0.15rem 0.5rem; border-radius: 9999px; font-size: 0.65rem; font-weight: 700; }
        
        /* ===== Progress bar ===== */
        .mc-progress-bar { height: 6px; border-radius: 3px; background: #e5e7eb; overflow: hidden; }
        .mc-progress-fill { height: 100%; border-radius: 3px; transition: width 0.5s ease; }
        
        /* ===== Typing animation ===== */
        @keyframes mc-dot { 0%,80%,100% { transform: scale(0) } 40% { transform: scale(1) } }
        .mc-typing-dot { width: 8px; height: 8px; border-radius: 50%; background: #a78bfa; display: inline-block; animation: mc-dot 1.4s infinite ease-in-out both; }
        .mc-typing-dot:nth-child(2) { animation-delay: 0.16s; }
        .mc-typing-dot:nth-child(3) { animation-delay: 0.32s; }
        
        /* ===== Scrollbar ===== */
        .mc-scroll::-webkit-scrollbar { width: 6px; }
        .mc-scroll::-webkit-scrollbar-track { background: transparent; }
        .mc-scroll::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 3px; }
        
        /* Voice/style select chip */
        .voice-chip { padding: 0.35rem 0.75rem; border-radius: 0.5rem; font-size: 0.75rem; cursor: pointer; transition: all 0.2s; border: 2px solid #e5e7eb; }
        .voice-chip.active { border-color: #7c3aed; background: #ede9fe; color: #5b21b6; }
        /* Character toggle chip (multi-select) */
        .char-chip { padding: 0.3rem 0.65rem; border-radius: 0.5rem; font-size: 0.72rem; cursor: pointer; transition: all 0.2s; border: 2px solid #e5e7eb; background: #fff; display: inline-flex; align-items: center; gap: 0.25rem; }
        .char-chip.selected { border-color: #2563eb; background: #eff6ff; color: #1e40af; }
        .char-chip.disabled { opacity: 0.4; cursor: not-allowed; }
        /* Voice provider tabs */
        .voice-prov-tab { padding: 0.2rem 0.5rem; border-radius: 0.375rem; font-size: 0.65rem; cursor: pointer; transition: all 0.15s; background: #f3f4f6; color: #6b7280; border: 1px solid transparent; }
        .voice-prov-tab.active { background: #7c3aed; color: #fff; }
        .voice-prov-tab:hover:not(.active) { background: #e5e7eb; }
        /* Voice item in list */
        .voice-item { padding: 0.25rem 0.55rem; border-radius: 0.375rem; font-size: 0.68rem; cursor: pointer; transition: all 0.15s; border: 1.5px solid #e5e7eb; background: #fff; display: inline-flex; align-items: center; gap: 0.3rem; white-space: nowrap; }
        .voice-item.active { border-color: #7c3aed; background: #ede9fe; color: #5b21b6; }
        .voice-item.unavailable { opacity: 0.35; cursor: not-allowed; }
        .voice-item .prov-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
        .prov-google { background: #4285f4; }
        .prov-elevenlabs { background: #000; }
        .prov-fish { background: #ff6b35; }
        
        /* Board section */
        .mc-board-section { background: #fff; }
        .mc-board-section-header { display: flex; align-items: center; justify-content: space-between; padding: 0.5rem 1rem; }
        .mc-board-section.locked { position: relative; pointer-events: none; }
        .mc-board-section.locked::after { content: ''; position: absolute; inset: 0; background: rgba(249,250,251,0.5); z-index: 1; border-radius: inherit; }
        .mc-lock-badge { display: inline-flex; align-items: center; gap: 2px; padding: 1px 6px; border-radius: 4px; background: #f3f4f6; color: #9ca3af; font-size: 10px; }
    </style>
</head>
<body class="bg-gray-50">
    <!-- Auth Loading -->
    <div id="mcAuthLoading" class="flex items-center justify-center h-screen">
        <div class="text-center">
            <i class="fas fa-spinner fa-spin text-4xl text-purple-600 mb-4"></i>
            <p class="text-gray-600">認証を確認中...</p>
        </div>
    </div>

    <!-- Main Shell (hidden until authed) -->
    <div id="mcShell" class="mc-shell hidden">
        <!-- ===== LEFT BOARD ===== -->
        <div id="mcLeft" class="mc-left">
            <!-- Left Header -->
            <div class="flex items-center justify-between px-4 py-3 bg-white border-b border-gray-200">
                <div class="flex items-center gap-3">
                    <a href="/marunage" class="text-gray-500 hover:text-gray-700"><i class="fas fa-arrow-left"></i></a>
                    <div>
                        <h1 class="text-sm font-bold text-gray-800">
                            <i class="fas fa-comments text-purple-600 mr-1"></i>丸投げチャット
                        </h1>
                        <p id="mcProjectTitle" class="text-xs text-gray-500">新しい動画素材を作成</p>
                    </div>
                </div>
                <div class="flex items-center gap-2">
                    <span id="mcPhaseBadge" class="text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-600">idle</span>
                    <!-- Mobile toggle -->
                    <button id="mcToggleView" class="md:hidden text-gray-500 hover:text-purple-600 p-1">
                        <i class="fas fa-columns"></i>
                    </button>
                </div>
            </div>
            
            <!-- Phase Progress -->
            <div class="px-4 py-2 bg-white border-b border-gray-100">
                <div class="flex items-center justify-between mb-1">
                    <span class="text-xs font-semibold text-gray-600">進捗</span>
                    <span id="mcProgressPercent" class="text-xs font-bold text-purple-600">0%</span>
                </div>
                <div class="mc-progress-bar">
                    <div id="mcProgressFill" class="mc-progress-fill bg-gradient-to-r from-purple-500 to-pink-500" style="width: 0%"></div>
                </div>
                <div class="flex justify-between mt-1">
                    <span id="mcStep1" class="text-[10px] text-gray-400"><i class="fas fa-edit"></i> 整形</span>
                    <span id="mcStep2" class="text-[10px] text-gray-400"><i class="fas fa-check"></i> 確認</span>
                    <span id="mcStep3" class="text-[10px] text-gray-400"><i class="fas fa-image"></i> 画像</span>
                    <span id="mcStep4" class="text-[10px] text-gray-400"><i class="fas fa-volume-up"></i> 音声</span>
                    <span id="mcStep5" class="text-[10px] text-gray-400"><i class="fas fa-film"></i> 動画</span>
                    <span id="mcStep6" class="text-[10px] text-gray-400"><i class="fas fa-flag-checkered"></i> 完了</span>
                </div>
                <!-- Phase detail text (e.g. 画像: 2/5枚完了) -->
                <p id="mcPhaseDetail" class="text-xs text-gray-500 mt-1.5 text-center hidden"></p>
            </div>
            
            <!-- Board Content: 4 Sections (B-spec) -->
            <div id="mcBoardContent" class="flex-1 overflow-y-auto mc-scroll">
                <!-- ===== Section 1: Characters ===== -->
                <div id="mcBoardCharacters" class="mc-board-section border-b border-gray-100">
                    <div class="mc-board-section-header">
                        <span class="text-xs font-semibold text-gray-600">
                            <i class="fas fa-users mr-1 text-blue-500"></i>キャラクター
                            <span class="text-[10px] text-gray-400 font-normal ml-1">任意・最大3名</span>
                        </span>
                        <span id="mcBoardCharLock" class="mc-lock-badge hidden" title="生成中のため変更できません（再生成はv2）">
                            <i class="fas fa-lock text-[10px]"></i>
                        </span>
                    </div>
                    <div class="px-4 pb-3">
                        <div id="mcCharacterList" class="flex flex-wrap gap-1.5">
                            <span class="text-xs text-gray-400"><i class="fas fa-spinner fa-spin mr-1"></i>読み込み中...</span>
                        </div>
                        <p id="mcCharacterHint" class="text-[10px] text-gray-400 mt-1 hidden">
                            <i class="fas fa-info-circle mr-1"></i>キャラは <a href="/settings" class="text-purple-500 hover:underline">設定</a> から追加できます
                        </p>
                        <!-- Locked state: confirmed characters display -->
                        <div id="mcCharacterLocked" class="hidden">
                            <div id="mcCharacterConfirmed" class="flex flex-wrap gap-1.5"></div>
                        </div>
                    </div>
                </div>
                
                <!-- ===== Section 2: Style ===== -->
                <div id="mcBoardStyle" class="mc-board-section border-b border-gray-100">
                    <div class="mc-board-section-header">
                        <span class="text-xs font-semibold text-gray-600">
                            <i class="fas fa-palette mr-1 text-pink-500"></i>スタイル
                        </span>
                        <span id="mcBoardStyleLock" class="mc-lock-badge hidden" title="生成中のため変更できません（再生成はv2）">
                            <i class="fas fa-lock text-[10px]"></i>
                        </span>
                    </div>
                    <div class="px-4 pb-3">
                        <div id="mcStyleList" class="flex flex-wrap gap-1.5">
                            <span class="text-xs text-gray-400"><i class="fas fa-spinner fa-spin mr-1"></i>読み込み中...</span>
                        </div>
                        <!-- Locked state: confirmed style display -->
                        <div id="mcStyleLocked" class="hidden">
                            <span id="mcStyleConfirmed" class="text-xs text-gray-700 font-medium"></span>
                        </div>
                    </div>
                </div>
                
                <!-- ===== Section 3: Voice ===== -->
                <div id="mcBoardVoice" class="mc-board-section border-b border-gray-100">
                    <div class="mc-board-section-header">
                        <span class="text-xs font-semibold text-gray-600">
                            <i class="fas fa-microphone-alt mr-1 text-purple-500"></i>ナレーション音声
                        </span>
                        <span id="mcBoardVoiceLock" class="mc-lock-badge hidden" title="生成中のため変更できません（再生成はv2）">
                            <i class="fas fa-lock text-[10px]"></i>
                        </span>
                    </div>
                    <div class="px-4 pb-3">
                        <!-- Provider Tabs -->
                        <div id="mcVoiceProvTabs" class="flex gap-1 mb-1.5">
                            <button class="voice-prov-tab active" data-prov="all" onclick="mcFilterVoices('all',this)">すべて</button>
                            <button class="voice-prov-tab" data-prov="google" onclick="mcFilterVoices('google',this)">Google</button>
                            <button class="voice-prov-tab" data-prov="elevenlabs" onclick="mcFilterVoices('elevenlabs',this)">ElevenLabs</button>
                            <button class="voice-prov-tab" data-prov="fish" onclick="mcFilterVoices('fish',this)">Fish</button>
                        </div>
                        <!-- Search -->
                        <input type="text" id="mcVoiceSearch" placeholder="ボイス名で検索..." 
                               class="w-full px-2 py-1 text-xs border border-gray-200 rounded-md mb-1.5 focus:outline-none focus:ring-1 focus:ring-purple-300"
                               oninput="mcFilterVoicesBySearch(this.value)">
                        <!-- Voice List -->
                        <div id="mcVoiceList" class="max-h-28 overflow-y-auto mc-scroll flex flex-wrap gap-1">
                            <span class="text-xs text-gray-400"><i class="fas fa-spinner fa-spin mr-1"></i>読み込み中...</span>
                        </div>
                        <!-- Fish Custom ID Input -->
                        <div id="mcFishCustom" class="mt-1.5 border border-dashed border-purple-200 rounded-md p-2 bg-purple-50/30">
                            <div class="flex items-center gap-1 mb-1">
                                <i class="fas fa-fish text-purple-400 text-[10px]"></i>
                                <span class="text-[10px] font-medium text-purple-600">カスタム Fish Audio ID</span>
                            </div>
                            <div class="flex gap-1">
                                <input type="text" id="mcFishIdInput" placeholder="例: 71bf4cb71cd44df6aa603d51db8f92ff"
                                       class="flex-1 px-2 py-1 text-[11px] border border-gray-200 rounded font-mono focus:outline-none focus:ring-1 focus:ring-purple-300"
                                       oninput="mcValidateFishId(this.value)">
                                <button id="mcFishIdApply" onclick="mcApplyFishId()" disabled
                                        class="px-2 py-1 text-[10px] bg-purple-500 text-white rounded hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap">
                                    適用
                                </button>
                            </div>
                            <p class="text-[9px] text-gray-400 mt-0.5">
                                <a href="https://fish.audio/models" target="_blank" class="text-purple-400 hover:underline">fish.audio/models</a> からIDをコピー
                            </p>
                        </div>
                        <!-- Selected indicator -->
                        <div id="mcVoiceSelected" class="text-[10px] text-purple-600 mt-1 hidden">
                            <i class="fas fa-check-circle mr-0.5"></i><span id="mcVoiceSelectedName">-</span>
                        </div>
                        <!-- Locked state: confirmed voice display -->
                        <div id="mcVoiceLocked" class="hidden">
                            <span id="mcVoiceConfirmed" class="text-xs text-gray-700 font-medium"></span>
                        </div>
                    </div>
                </div>
                
                <!-- ===== Section 3.5: Output Settings (Preset + Scene Count) ===== -->
                <div id="mcBoardOutputSettings" class="mc-board-section border-b border-gray-100">
                    <div class="mc-board-section-header">
                        <span class="text-xs font-semibold text-gray-600">
                            <i class="fas fa-sliders-h mr-1 text-indigo-500"></i>出力設定
                        </span>
                        <span id="mcBoardOutputLock" class="mc-lock-badge hidden" title="生成中のため変更できません（再生成はv2）">
                            <i class="fas fa-lock text-[10px]"></i>
                        </span>
                    </div>
                    <div class="px-4 pb-3">
                        <div class="mb-2">
                            <span class="text-[10px] text-gray-500 block mb-1">プリセット</span>
                            <div id="mcOutputPresetList" class="flex gap-1.5">
                                <button class="voice-chip active" data-preset="yt_long" onclick="selectPreset(this)">
                                    <i class="fas fa-desktop mr-1"></i>YouTube横型
                                </button>
                                <button class="voice-chip" data-preset="short_vertical" onclick="selectPreset(this)">
                                    <i class="fas fa-mobile-alt mr-1"></i>縦型ショート
                                </button>
                            </div>
                        </div>
                        <div>
                            <span class="text-[10px] text-gray-500 block mb-1">シーン数</span>
                            <div id="mcSceneCountList" class="flex flex-wrap gap-1.5">
                                <button class="voice-chip" data-scenes="3" onclick="selectSceneCount(this)">
                                    3枚 <span class="text-[10px] ml-0.5 opacity-60">速い</span>
                                </button>
                                <button class="voice-chip active" data-scenes="5" onclick="selectSceneCount(this)">
                                    5枚 <span class="text-[10px] ml-0.5 opacity-60">標準</span>
                                </button>
                                <button class="voice-chip" data-scenes="7" onclick="selectSceneCount(this)">
                                    7枚
                                </button>
                                <button class="voice-chip" data-scenes="10" onclick="selectSceneCount(this)">
                                    10枚
                                </button>
                                <button class="voice-chip" data-scenes="custom" onclick="mcShowCustomSceneCount()" title="カスタムシーン数">
                                    <i class="fas fa-sliders-h text-[10px]"></i>
                                </button>
                            </div>
                            <!-- P-1: Custom scene count input (hidden by default) -->
                            <div id="mcCustomSceneCount" class="hidden mt-1.5">
                                <div class="flex items-center gap-1.5">
                                    <input type="number" id="mcCustomSceneInput" min="1" max="200" value="15"
                                           class="w-16 px-2 py-0.5 text-xs border border-gray-300 rounded focus:outline-none focus:border-purple-400"
                                           onchange="mcApplyCustomSceneCount()">
                                    <span class="text-[10px] text-gray-400">枚 (1-200)</span>
                                    <button onclick="mcApplyCustomSceneCount()" class="text-[10px] px-2 py-0.5 bg-purple-100 text-purple-700 rounded hover:bg-purple-200">適用</button>
                                </div>
                                <div id="mcSceneCountWarning" class="hidden text-[10px] text-amber-600 mt-1">
                                    <i class="fas fa-exclamation-triangle mr-0.5"></i><span></span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- ===== Section 4: Assets / Progress ===== -->
                <div id="mcBoardAssets" class="mc-board-section">
                    <div class="mc-board-section-header">
                        <span class="text-xs font-semibold text-gray-600">
                            <i class="fas fa-photo-video mr-1 text-green-500"></i>アセット
                        </span>
                    </div>
                    <div class="px-4 pb-3">
                        <!-- Idle state -->
                        <div id="mcBoardIdle" class="flex flex-col items-center justify-center py-6 text-center">
                            <div class="w-14 h-14 bg-purple-100 rounded-full flex items-center justify-center mb-3">
                                <i class="fas fa-film text-purple-500 text-xl"></i>
                            </div>
                            <h3 class="text-sm font-bold text-gray-700 mb-1">動画素材を自動生成</h3>
                            <p class="text-xs text-gray-500 leading-relaxed">
                                右のチャットにシナリオを貼り付けると、<br>
                                画像 + ナレーション音声を自動生成します。
                            </p>
                        </div>
                        
                        <!-- P2: Assets Summary (3-column: images/audio/video) -->
                        <div id="mcAssetsSummary" class="hidden mb-3">
                            <div class="grid grid-cols-3 gap-2 text-center">
                                <div class="bg-gray-50 rounded-lg p-2">
                                    <div id="mcAssetsImages" class="text-sm font-bold text-gray-800">-/-</div>
                                    <div class="text-[10px] text-gray-500"><i class="fas fa-image mr-0.5"></i>画像</div>
                                </div>
                                <div class="bg-gray-50 rounded-lg p-2">
                                    <div id="mcAssetsAudio" class="text-sm font-bold text-gray-800">-/-</div>
                                    <div class="text-[10px] text-gray-500"><i class="fas fa-volume-up mr-0.5"></i>音声</div>
                                </div>
                                <div class="bg-gray-50 rounded-lg p-2">
                                    <div id="mcAssetsVideo" class="text-sm font-bold text-gray-800">--</div>
                                    <div class="text-[10px] text-gray-500"><i class="fas fa-video mr-0.5"></i>動画</div>
                                </div>
                            </div>
                            <p id="mcAssetsHint" class="text-[10px] text-gray-400 mt-1.5 text-center">
                                <i class="fas fa-info-circle mr-0.5"></i>開始後はこのボードで進捗を確認します
                            </p>
                        </div>
                        
                        <!-- T2: Edit banner (shown when scene is selected for editing) -->
                        <div id="mcEditBanner" class="hidden mb-2">
                            <div class="bg-purple-50 border border-purple-200 rounded-lg px-3 py-2 text-xs text-purple-800 flex items-center justify-between">
                                <div id="mcEditBannerText" class="flex items-center gap-1">
                                    <i class="fas fa-crosshairs text-purple-500"></i>
                                    <span>編集中: -</span>
                                </div>
                                <button id="mcEditBannerClear" onclick="mcClearSceneSelection()"
                                        class="text-[11px] text-purple-400 hover:text-purple-700 transition-colors">
                                    <i class="fas fa-times mr-0.5"></i>解除
                                </button>
                            </div>
                        </div>
                        
                        <!-- Scene cards (populated dynamically) -->
                        <div id="mcSceneCards" class="space-y-3 hidden">
                            <!-- Rendered by JS -->
                        </div>
                        
                        <!-- T1: Video Preview (always present in ready phase, content controlled by JS) -->
                        <div id="mcBoardVideoPreview" class="hidden mt-3 transition-all duration-300">
                            <div class="bg-gradient-to-r from-green-50 to-emerald-50 rounded-xl border border-green-200 p-3">
                                <div class="flex items-center justify-between mb-2">
                                    <span class="text-xs font-bold text-green-700">
                                        <i class="fas fa-film mr-1"></i>動画
                                    </span>
                                    <span id="mcBoardVideoTimestamp" class="text-[10px] text-green-500"></span>
                                </div>
                                <!-- Video player (shown when done) -->
                                <video id="mcBoardVideoPlayer" controls playsinline preload="metadata"
                                       class="w-full rounded-lg bg-black hidden" style="max-height: 220px;">
                                </video>
                                <!-- T1: Placeholder (shown when no video yet / running / failed) -->
                                <div id="mcBoardVideoPlaceholder" class="w-full rounded-lg bg-gray-900/90 text-white/80 text-xs flex items-center justify-center"
                                     style="height: 160px;">
                                    <div class="text-center">
                                        <div class="mb-2 text-lg"><i class="fas fa-film"></i></div>
                                        <div id="mcBoardVideoPlaceholderText">動画未生成</div>
                                    </div>
                                </div>
                                <div id="mcBoardVideoStatus" class="text-[10px] text-green-600 mt-1.5 text-center">
                                    <!-- Updated dynamically -->
                                </div>
                                <!-- A-2: Action buttons -->
                                <div id="mcBoardVideoActions" class="flex items-center gap-2 mt-2">
                                    <a id="mcBoardVideoDL" href="#" target="_blank" rel="noopener"
                                       class="flex-1 text-center text-xs px-3 py-1.5 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 no-underline hidden">
                                        <i class="fas fa-download mr-1"></i>ダウンロード
                                    </a>
                                    <button id="mcBoardVideoRebuild" onclick="mcRebuildVideo()"
                                            class="flex-1 text-xs px-3 py-1.5 bg-purple-100 text-purple-700 rounded-lg font-semibold hover:bg-purple-200 hidden">
                                        <i class="fas fa-redo mr-1"></i>再ビルド
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- Left Footer -->
            <div class="px-4 py-2 bg-gray-50 border-t border-gray-200 flex items-center justify-between">
                <span class="text-[10px] text-gray-400 font-mono">exp: marunage_chat_v1</span>
                <span id="mcUpdatedAt" class="text-[10px] text-gray-400"></span>
            </div>
        </div>
        
        <!-- ===== RIGHT CHAT ===== -->
        <div id="mcRight" class="mc-right">
            <!-- Chat Header -->
            <div class="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-purple-600 to-indigo-600 text-white">
                <div class="flex items-center gap-2">
                    <i class="fas fa-robot text-lg"></i>
                    <span class="font-bold text-sm">アシスタント</span>
                </div>
                <div class="flex items-center gap-2">
                    <button id="mcCancelBtn" class="hidden text-white/80 hover:text-white text-xs px-2 py-1 rounded border border-white/30 hover:bg-white/10">
                        <i class="fas fa-stop mr-1"></i>中断
                    </button>
                    <a href="/marunage" class="text-white/80 hover:text-white">
                        <i class="fas fa-home"></i>
                    </a>
                </div>
            </div>
            
            <!-- Chat Messages -->
            <div id="mcChatMessages" class="flex-1 overflow-y-auto mc-scroll p-4 space-y-3">
                <!-- Welcome message -->
                <div class="flex justify-start">
                    <div class="chat-bubble chat-system">
                        <p class="font-semibold mb-1"><i class="fas fa-hand-sparkles mr-1"></i>丸投げチャットへようこそ！</p>
                        <p class="text-sm">シナリオテキストを貼り付けてください。<br>5シーンの画像とナレーション音声を自動で生成します。</p>
                        <p class="text-xs mt-2 text-purple-400">
                            <i class="fas fa-info-circle mr-1"></i>100文字以上のテキストが必要です
                        </p>
                    </div>
                </div>
            </div>
            
            
            <!-- Chat Input -->
            <div class="px-4 py-3 bg-white border-t border-gray-200">
                <div class="flex items-end gap-2">
                    <textarea 
                        id="mcChatInput" 
                        rows="3"
                        placeholder="シナリオテキストを貼り付けてください..."
                        class="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm resize-none"
                    ></textarea>
                    <button 
                        id="mcSendBtn"
                        onclick="mcSendMessage()"
                        class="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <i class="fas fa-paper-plane"></i>
                    </button>
                </div>
                <div class="flex items-center justify-between mt-1">
                    <span id="mcCharCount" class="text-xs text-gray-400">0文字</span>
                    <span id="mcInputHint" class="text-xs text-gray-400">Ctrl+Enter で送信</span>
                </div>
            </div>
        </div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
    <script src="/static/marunage-chat.js?v=${ASSET_VERSION}"></script>
</body>
</html>
  `)
})

// ============================================================
// Global Error Handler — suppress stack traces in production
// ============================================================
app.onError((err, c) => {
  // Full details for server logs only
  console.error(`[Global] Unhandled error: ${err.message}\n${err.stack}`)

  // Client gets only a safe generic message
  return c.json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    }
  }, 500)
})

export default app
