import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'
import type { Bindings } from './types/bindings'
import projects from './routes/projects'
import transcriptions from './routes/transcriptions'
import formatting from './routes/formatting'
import imageGeneration from './routes/image-generation'
import downloads from './routes/downloads'
import scenes from './routes/scenes'
import images from './routes/images'

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
app.route('/api/projects', formatting)
app.route('/api/projects', imageGeneration)
app.route('/api/projects', downloads) // For download endpoints
app.route('/api/projects', scenes) // For /api/projects/:id/scenes/reorder
app.route('/api/scenes', scenes) // For /api/scenes/:id (PUT/DELETE)
app.route('/api/scenes', images) // For /api/scenes/:id/images
app.route('/api/images', images) // For /api/images/:id/activate
app.route('/api', imageGeneration) // For /api/scenes/:id/generate-image

// Root route - serve HTML
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
    </style>
</head>
<body class="bg-gray-100 min-h-screen">
    <div class="container mx-auto px-4 py-8">
        <h1 class="text-3xl font-bold text-gray-800 mb-8">
            <i class="fas fa-video mr-2 text-blue-600"></i>
            RILARC Scenario Generator
        </h1>
        
        <!-- Phase 1: プロジェクト作成 -->
        <div class="bg-white rounded-lg shadow-md p-6 mb-6">
            <h2 class="text-xl font-semibold text-gray-700 mb-4">
                <i class="fas fa-folder-plus mr-2 text-blue-600"></i>
                新規プロジェクト作成
            </h2>
            <div class="flex gap-4">
                <input 
                    type="text" 
                    id="projectTitle" 
                    placeholder="プロジェクトタイトルを入力"
                    class="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button 
                    id="createProjectBtn"
                    onclick="createProject()"
                    class="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                >
                    <i class="fas fa-plus mr-2"></i>作成
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

    <!-- Toast通知 -->
    <div id="toast" class="fixed top-4 right-4 hidden z-50">
        <div class="bg-white border-l-4 rounded-lg shadow-lg p-4 max-w-sm">
            <div class="flex items-center">
                <i id="toastIcon" class="fas fa-check-circle text-2xl mr-3"></i>
                <p id="toastMessage" class="text-gray-800"></p>
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
                
                <!-- Scenes Table -->
                <div id="scenesSection" class="hidden">
                    <div class="flex items-center justify-between mb-4">
                        <h3 class="text-lg font-semibold text-gray-800">
                            シーン一覧（<span id="scenesCount">0</span>件）
                        </h3>
                        <button 
                            id="goToBuilderBtn"
                            onclick="goToBuilder()"
                            class="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-semibold touch-manipulation hidden"
                        >
                            <i class="fas fa-arrow-right mr-2"></i>Builderへ進む
                        </button>
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
                
                <!-- Top Action Bar -->
                <div class="mb-6 p-4 bg-gray-50 rounded-lg border-2 border-gray-200">
                    <div class="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                        <!-- Bulk Generation Buttons -->
                        <div class="flex flex-wrap gap-2">
                            <button 
                                id="generateAllImagesBtn"
                                onclick="generateBulkImages('all')"
                                class="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-semibold touch-manipulation"
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
                        
                        <!-- Download Buttons -->
                        <div class="flex flex-wrap gap-2">
                            <button 
                                onclick="downloadImages()"
                                class="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-semibold touch-manipulation"
                            >
                                <i class="fas fa-download mr-2"></i>images.zip
                            </button>
                            <button 
                                onclick="downloadCSV()"
                                class="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-semibold touch-manipulation"
                            >
                                <i class="fas fa-file-csv mr-2"></i>dialogue.csv
                            </button>
                            <button 
                                onclick="downloadAll()"
                                class="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-semibold touch-manipulation"
                            >
                                <i class="fas fa-archive mr-2"></i>all.zip
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

            <div id="contentExport" class="hidden">
                <h2 class="text-xl font-bold text-gray-800 mb-4">Export</h2>
                <p class="text-gray-600">Phase 5 で実装予定</p>
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
    </div>

    <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
    <script>
        const PROJECT_ID = ${projectId};
    </script>
    <script src="/static/project-editor.js"></script>
</body>
</html>
  `)
})

export default app
