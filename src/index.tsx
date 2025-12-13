import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'
import type { Bindings } from './types/bindings'
import projects from './routes/projects'
import transcriptions from './routes/transcriptions'
import formatting from './routes/formatting'
import imageGeneration from './routes/image-generation'
import downloads from './routes/downloads'

const app = new Hono<{ Bindings: Bindings }>()

// Enable CORS for API routes
app.use('/api/*', cors())

// Serve static files
app.use('/static/*', serveStatic({ root: './public' }))

// API routes
app.route('/api/projects', projects)
app.route('/api/projects', transcriptions)
app.route('/api/projects', formatting)
app.route('/api/projects', imageGeneration)
app.route('/api/projects', downloads) // For download endpoints
app.route('/api', imageGeneration) // For /api/scenes/:id/generate-image

// Root route - serve HTML
app.get('/', (c) => {
  return c.html(`
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>RILARC Scenario Generator</title>
    <link rel="icon" type="image/svg+xml" href="/static/favicon.svg">
    <link href="/static/styles.css" rel="stylesheet">
    <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
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

export default app
