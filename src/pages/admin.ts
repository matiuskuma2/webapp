export const adminHtml = `

<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>管理画面 - RILARC Scenario Generator</title>
    <link rel="icon" type="image/svg+xml" href="/static/favicon.svg">
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
</head>
<body class="bg-gray-100 min-h-screen">
    <!-- Header -->
    <header class="bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-lg">
        <div class="container mx-auto px-4 py-4 flex items-center justify-between">
            <h1 class="text-xl font-bold">
                <i class="fas fa-cog mr-2"></i>
                管理画面
            </h1>
            <div class="flex items-center gap-4">
                <a href="/" class="text-white hover:text-gray-200">
                    <i class="fas fa-home mr-1"></i>ホーム
                </a>
                <button id="logoutBtn" class="px-4 py-2 bg-white/20 rounded-lg hover:bg-white/30 transition-colors">
                    <i class="fas fa-sign-out-alt mr-1"></i>ログアウト
                </button>
            </div>
        </div>
    </header>
    
    <!-- Tab Navigation -->
    <div class="bg-white border-b">
        <div class="container mx-auto px-4">
            <nav class="flex gap-4">
                <button class="admin-tab px-4 py-3 font-semibold border-b-2 border-purple-600 text-purple-600" data-tab="users">
                    <i class="fas fa-users mr-2"></i>ユーザー管理
                </button>
                <button class="admin-tab px-4 py-3 font-semibold border-b-2 border-transparent text-gray-500 hover:text-gray-700" data-tab="cost">
                    <i class="fas fa-chart-line mr-2"></i>コスト管理
                </button>
                <button class="admin-tab px-4 py-3 font-semibold border-b-2 border-transparent text-gray-500 hover:text-gray-700" data-tab="videoBuild">
                    <i class="fas fa-film mr-2"></i>Video Build
                </button>
                <button class="admin-tab px-4 py-3 font-semibold border-b-2 border-transparent text-gray-500 hover:text-gray-700" data-tab="sales">
                    <i class="fas fa-yen-sign mr-2"></i>売上管理
                </button>
                <button class="admin-tab px-4 py-3 font-semibold border-b-2 border-transparent text-gray-500 hover:text-gray-700" data-tab="subscriptions">
                    <i class="fas fa-credit-card mr-2"></i>課金管理
                </button>
                <button class="admin-tab px-4 py-3 font-semibold border-b-2 border-transparent text-gray-500 hover:text-gray-700" data-tab="settings">
                    <i class="fas fa-cog mr-2"></i>システム設定
                </button>
                <button class="admin-tab px-4 py-3 font-semibold border-b-2 border-transparent text-gray-500 hover:text-gray-700" data-tab="audioLibrary">
                    <i class="fas fa-music mr-2"></i>音声ライブラリ
                </button>
            </nav>
        </div>
    </div>
    
    <!-- Main Content -->
    <main class="container mx-auto px-4 py-8">
        <!-- Auth Check -->
        <div id="authCheck" class="text-center py-12">
            <i class="fas fa-spinner fa-spin text-4xl text-gray-400 mb-4"></i>
            <p class="text-gray-600">認証を確認中...</p>
        </div>
        
        <!-- Admin Content (hidden until auth check) -->
        <div id="adminContent" class="hidden">
            
            <!-- Users Tab -->
            <div id="usersTab">
                <!-- User Stats -->
                <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
                    <div class="bg-white rounded-xl shadow p-6">
                        <div class="flex items-center gap-4">
                            <div class="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center">
                                <i class="fas fa-users text-blue-600 text-xl"></i>
                            </div>
                            <div>
                            <p class="text-gray-500 text-sm">全ユーザー</p>
                            <p id="totalUsers" class="text-2xl font-bold text-gray-800">-</p>
                        </div>
                    </div>
                </div>
                <div class="bg-white rounded-xl shadow p-6">
                    <div class="flex items-center gap-4">
                        <div class="w-12 h-12 bg-yellow-100 rounded-full flex items-center justify-center">
                            <i class="fas fa-clock text-yellow-600 text-xl"></i>
                        </div>
                        <div>
                            <p class="text-gray-500 text-sm">承認待ち</p>
                            <p id="pendingUsers" class="text-2xl font-bold text-gray-800">-</p>
                        </div>
                    </div>
                </div>
                <div class="bg-white rounded-xl shadow p-6">
                    <div class="flex items-center gap-4">
                        <div class="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center">
                            <i class="fas fa-check text-green-600 text-xl"></i>
                        </div>
                        <div>
                            <p class="text-gray-500 text-sm">アクティブ</p>
                            <p id="activeUsers" class="text-2xl font-bold text-gray-800">-</p>
                        </div>
                    </div>
                </div>
                <div class="bg-white rounded-xl shadow p-6">
                    <div class="flex items-center gap-4">
                        <div class="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center">
                            <i class="fas fa-ban text-red-600 text-xl"></i>
                        </div>
                        <div>
                            <p class="text-gray-500 text-sm">停止中</p>
                            <p id="suspendedUsers" class="text-2xl font-bold text-gray-800">-</p>
                        </div>
                    </div>
                </div>
            </div>
            
                <!-- Search Box -->
                <div class="bg-white rounded-xl shadow mb-6 p-4">
                    <div class="flex gap-4">
                        <div class="flex-1 relative">
                            <i class="fas fa-search absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400"></i>
                            <input type="text" id="userSearch" placeholder="名前またはメールで検索..."
                                class="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500" />
                        </div>
                    </div>
                </div>
                
                <!-- Filter Tabs -->
                <div class="bg-white rounded-xl shadow mb-6">
                    <div class="flex border-b flex-wrap">
                        <button class="filter-tab px-6 py-4 font-semibold text-gray-600 border-b-2 border-transparent hover:text-gray-800" data-filter="all">
                            すべて
                        </button>
                        <button class="filter-tab px-6 py-4 font-semibold text-yellow-600 border-b-2 border-transparent hover:text-yellow-800" data-filter="pending">
                            <i class="fas fa-clock mr-1"></i>承認待ち
                        </button>
                        <button class="filter-tab px-6 py-4 font-semibold text-green-600 border-b-2 border-transparent hover:text-green-800" data-filter="active">
                            <i class="fas fa-check mr-1"></i>アクティブ
                        </button>
                        <button class="filter-tab px-6 py-4 font-semibold text-red-600 border-b-2 border-transparent hover:text-red-800" data-filter="suspended">
                            <i class="fas fa-ban mr-1"></i>停止中
                        </button>
                    </div>
                </div>
                
                <!-- Users List -->
                <div class="bg-white rounded-xl shadow">
                    <div class="p-6 border-b">
                        <h2 class="text-lg font-bold text-gray-800">
                            <i class="fas fa-users mr-2"></i>ユーザー一覧
                        </h2>
                    </div>
                    <div id="usersList" class="divide-y">
                        <div class="p-6 text-gray-500 text-center">読み込み中...</div>
                    </div>
                </div>
            </div>
            
            <!-- Cost Tab (Phase C-3-3) -->
            <div id="costTab" class="hidden">
                <!-- Cost Summary Cards -->
                <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                    <div class="bg-white rounded-xl shadow p-6 border-l-4 border-red-500">
                        <div class="flex items-center gap-4">
                            <div class="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center">
                                <i class="fas fa-hand-holding-usd text-red-600 text-xl"></i>
                            </div>
                            <div>
                                <p class="text-red-700 text-sm font-medium">運営負担コスト</p>
                                <p id="totalCost" class="text-2xl font-bold text-red-700">\$0.00</p>
                            </div>
                        </div>
                    </div>
                    <div class="bg-white rounded-xl shadow p-6">
                        <div class="flex items-center gap-4">
                            <div class="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center">
                                <i class="fas fa-server text-blue-600 text-xl"></i>
                            </div>
                            <div>
                                <p class="text-gray-500 text-sm">総リクエスト数</p>
                                <p id="totalRequests" class="text-2xl font-bold text-gray-800">0</p>
                            </div>
                        </div>
                    </div>
                    <div class="bg-white rounded-xl shadow p-6">
                        <div class="flex items-center gap-4">
                            <div class="w-12 h-12 bg-purple-100 rounded-full flex items-center justify-center">
                                <i class="fas fa-chart-pie text-purple-600 text-xl"></i>
                            </div>
                            <div>
                                <p class="text-gray-500 text-sm">API種別</p>
                                <p id="apiTypeCount" class="text-2xl font-bold text-gray-800">0種類</p>
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- Period Selector -->
                <div class="flex items-center justify-end mb-6 gap-3">
                    <select id="costDaysSelect" class="border rounded-lg px-3 py-2 text-sm">
                        <option value="7">過去7日</option>
                        <option value="30" selected>過去30日</option>
                        <option value="90">過去90日</option>
                    </select>
                    <button onclick="loadCostData()" class="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm font-semibold">
                        <i class="fas fa-sync-alt mr-1"></i>更新
                    </button>
                </div>
                
                <!-- Daily Cost Chart -->
                <div class="bg-white rounded-xl shadow mb-6">
                    <div class="p-4 border-b flex items-center justify-between">
                        <span class="font-semibold text-gray-700"><i class="fas fa-chart-line mr-2 text-green-600"></i>日別コスト推移</span>
                        <span class="text-xs text-gray-500">API種別ごとのコスト</span>
                    </div>
                    <div class="p-4 overflow-x-auto">
                        <svg id="costDailyChart" width="900" height="220"></svg>
                    </div>
                </div>
                
                <!-- Cost by Type -->
                <div class="bg-white rounded-xl shadow mb-6">
                    <div class="p-6 border-b">
                        <h2 class="text-lg font-bold text-gray-800">
                            <i class="fas fa-chart-bar mr-2 text-purple-600"></i>API種別コスト
                        </h2>
                    </div>
                    <div id="costByType" class="p-6">
                        <div class="text-gray-500 text-center py-4">読み込み中...</div>
                    </div>
                </div>
                
                <!-- Cost by User (運営負担分のみ) -->
                <div class="bg-white rounded-xl shadow mb-6">
                    <div class="p-6 border-b">
                        <h2 class="text-lg font-bold text-gray-800">
                            <i class="fas fa-hand-holding-usd mr-2 text-red-600"></i>運営負担コスト（TOP 10）
                        </h2>
                        <p class="text-sm text-gray-500 mt-1">
                            <i class="fas fa-info-circle mr-1"></i>
                            スポンサード利用分のみ表示（ユーザー自身のAPIキー利用は含まない）
                        </p>
                    </div>
                    <div id="costByUser" class="divide-y">
                        <div class="p-6 text-gray-500 text-center">読み込み中...</div>
                    </div>
                </div>
                
                <!-- Cost by User (全体参考値) -->
                <div class="bg-gray-50 rounded-xl shadow mb-6 border border-gray-200">
                    <div class="p-6 border-b">
                        <h2 class="text-lg font-bold text-gray-600">
                            <i class="fas fa-users mr-2 text-gray-500"></i>全体利用状況（参考：TOP 10）
                        </h2>
                        <p class="text-sm text-gray-500 mt-1">
                            <i class="fas fa-info-circle mr-1"></i>
                            全ユーザーの全利用（運営負担+ユーザー負担）
                        </p>
                    </div>
                    <div id="costByUserAll" class="divide-y">
                        <div class="p-6 text-gray-500 text-center">読み込み中...</div>
                    </div>
                </div>
                
                <!-- Sponsor Usage Section -->
                <div class="bg-white rounded-xl shadow">
                    <div class="p-6 border-b flex items-center justify-between">
                        <h2 class="text-lg font-bold text-gray-800">
                            <i class="fas fa-star mr-2 text-yellow-500"></i>スポンサー使用量
                        </h2>
                        <button onclick="loadSponsorUsage()" class="px-3 py-1 bg-yellow-500 text-white rounded hover:bg-yellow-600 text-sm">
                            <i class="fas fa-sync-alt mr-1"></i>更新
                        </button>
                    </div>
                    <div id="sponsorUsage" class="p-6">
                        <div class="text-gray-500 text-center py-4">読み込み中...</div>
                    </div>
                </div>
                
                <!-- Operations Usage Section (Safe Chat v1) -->
                <div class="bg-white rounded-xl shadow mt-6">
                    <div class="p-6 border-b flex items-center justify-between">
                        <h2 class="text-lg font-bold text-gray-800">
                            <i class="fas fa-cogs mr-2 text-indigo-600"></i>オペレーション使用量 (Safe Chat v1)
                        </h2>
                        <button onclick="loadOperationsUsage()" class="px-3 py-1 bg-indigo-600 text-white rounded hover:bg-indigo-700 text-sm">
                            <i class="fas fa-sync-alt mr-1"></i>更新
                        </button>
                    </div>
                    <div id="operationsUsage" class="p-6">
                        <div class="text-gray-500 text-center py-4">読み込み中...</div>
                    </div>
                    <div class="border-t p-6">
                        <h3 class="text-sm font-semibold text-gray-700 mb-4">
                            <i class="fas fa-history mr-1"></i>最近のオペレーション
                        </h3>
                        <div id="recentOperations" class="space-y-2 max-h-64 overflow-y-auto">
                            <div class="text-gray-500 text-center py-4">読み込み中...</div>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- Video Build Tab (Phase C) -->
            <div id="videoBuildTab" class="hidden">
                <!-- KPI Summary -->
                <div class="flex items-center justify-between mb-6">
                    <h2 class="text-lg font-bold text-gray-800">
                        <i class="fas fa-film mr-2 text-purple-600"></i>Video Build 運用状況
                    </h2>
                    <div class="flex items-center gap-3">
                        <select id="vbMonthSelect" class="border rounded-lg px-3 py-2 text-sm">
                        </select>
                        <button onclick="loadVideoBuildSummary()" class="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-sm font-semibold">
                            <i class="fas fa-sync-alt mr-1"></i>更新
                        </button>
                    </div>
                </div>
                
                <div class="grid grid-cols-1 md:grid-cols-5 gap-4 mb-6">
                    <div class="bg-white rounded-xl shadow p-4">
                        <div class="text-xs text-gray-500">総ビルド数</div>
                        <div id="vbKpiTotal" class="text-2xl font-bold text-gray-900">-</div>
                    </div>
                    <div class="bg-white rounded-xl shadow p-4 border-l-4 border-green-500">
                        <div class="text-xs text-green-700">完了</div>
                        <div id="vbKpiCompleted" class="text-2xl font-bold text-green-700">-</div>
                    </div>
                    <div class="bg-white rounded-xl shadow p-4 border-l-4 border-red-500">
                        <div class="text-xs text-red-700">失敗</div>
                        <div id="vbKpiFailed" class="text-2xl font-bold text-red-700">-</div>
                    </div>
                    <div class="bg-white rounded-xl shadow p-4 border-l-4 border-yellow-500">
                        <div class="text-xs text-yellow-700">再試行/待機</div>
                        <div id="vbKpiRetrying" class="text-2xl font-bold text-yellow-700">-</div>
                    </div>
                    <div class="bg-white rounded-xl shadow p-4 border-l-4 border-red-500">
                        <div class="text-xs text-red-700">運営負担コスト（Remotion）</div>
                        <div id="vbKpiCost" class="text-2xl font-bold text-red-700">-</div>
                    </div>
                </div>
                
                <!-- Daily Chart -->
                <div class="bg-white rounded-xl shadow mb-6">
                    <div class="p-4 border-b flex items-center justify-between">
                        <span class="font-semibold text-gray-700">日別推移</span>
                        <span class="text-xs text-gray-500">builds / completed / failed</span>
                    </div>
                    <div class="p-4 overflow-x-auto">
                        <svg id="vbDailyChart" width="900" height="220"></svg>
                    </div>
                </div>
                
                <!-- Owner / Executor Tables -->
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
                    <div class="bg-white rounded-xl shadow overflow-hidden">
                        <div class="p-4 bg-gray-50 border-b font-semibold text-gray-700">
                            <i class="fas fa-user mr-2"></i>ユーザー別（Owner）集計
                            <span class="text-xs text-gray-500 font-normal ml-2">※全て運営負担（Remotion Lambda）</span>
                        </div>
                        <div class="overflow-x-auto">
                            <table class="w-full text-sm">
                                <thead class="bg-white border-b">
                                    <tr>
                                        <th class="p-3 text-left">Owner</th>
                                        <th class="p-3 text-right">Builds</th>
                                        <th class="p-3 text-right">OK</th>
                                        <th class="p-3 text-right">NG</th>
                                        <th class="p-3 text-right text-red-700">運営負担</th>
                                    </tr>
                                </thead>
                                <tbody id="vbByOwnerTbody"></tbody>
                            </table>
                        </div>
                    </div>
                    
                    <div class="bg-white rounded-xl shadow overflow-hidden">
                        <div class="p-4 bg-gray-50 border-b font-semibold text-gray-700">
                            <i class="fas fa-user-shield mr-2"></i>実行者別（Executor）集計
                        </div>
                        <div class="overflow-x-auto">
                            <table class="w-full text-sm">
                                <thead class="bg-white border-b">
                                    <tr>
                                        <th class="p-3 text-left">Executor</th>
                                        <th class="p-3 text-right">Total</th>
                                        <th class="p-3 text-right">代行</th>
                                        <th class="p-3 text-right">Cost</th>
                                    </tr>
                                </thead>
                                <tbody id="vbByExecutorTbody"></tbody>
                            </table>
                        </div>
                    </div>
                </div>
                
                <!-- Recent Failed -->
                <div class="bg-white rounded-xl shadow">
                    <div class="p-4 bg-gray-50 border-b font-semibold text-gray-700">
                        <i class="fas fa-exclamation-triangle mr-2 text-red-600"></i>直近の失敗（監視用）
                    </div>
                    <div class="overflow-x-auto">
                        <table class="w-full text-sm">
                            <thead class="bg-white border-b">
                                <tr>
                                    <th class="p-3 text-left">BuildID</th>
                                    <th class="p-3 text-left">Owner</th>
                                    <th class="p-3 text-left">Error</th>
                                    <th class="p-3 text-left">Created</th>
                                </tr>
                            </thead>
                            <tbody id="vbRecentFailedTbody"></tbody>
                        </table>
                    </div>
                </div>
            </div>
            
            <!-- Sales Tab (売上管理) -->
            <div id="salesTab" class="hidden">
                <!-- Month Selector -->
                <div class="mb-6 flex items-center justify-between bg-white rounded-xl shadow p-4">
                    <div class="flex items-center gap-4">
                        <label class="text-gray-700 font-medium">期間:</label>
                        <select id="salesMonthSelect" onchange="onSalesMonthChange()" class="border rounded-lg px-3 py-2">
                        </select>
                        <button onclick="onSalesMonthChange()" class="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700">
                            <i class="fas fa-sync-alt mr-1"></i>更新
                        </button>
                    </div>
                    <button onclick="exportSalesCsv()" class="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700">
                        <i class="fas fa-download mr-1"></i>CSVエクスポート
                    </button>
                </div>
                
                <!-- Sales Summary Cards -->
                <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
                    <div class="bg-white rounded-xl shadow p-6 border-l-4 border-green-500">
                        <div class="flex items-center gap-4">
                            <div class="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center">
                                <i class="fas fa-yen-sign text-green-600 text-xl"></i>
                            </div>
                            <div>
                                <p class="text-gray-500 text-sm">総売上</p>
                                <p id="salesKpiTotal" class="text-2xl font-bold text-green-600">¥-</p>
                            </div>
                        </div>
                    </div>
                    <div class="bg-white rounded-xl shadow p-6">
                        <div class="flex items-center gap-4">
                            <div class="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center">
                                <i class="fas fa-receipt text-blue-600 text-xl"></i>
                            </div>
                            <div>
                                <p class="text-gray-500 text-sm">総決済件数</p>
                                <p id="salesKpiCount" class="text-2xl font-bold text-gray-800">-</p>
                            </div>
                        </div>
                    </div>
                    <div class="bg-white rounded-xl shadow p-6">
                        <div class="flex items-center gap-4">
                            <div class="w-12 h-12 bg-purple-100 rounded-full flex items-center justify-center">
                                <i class="fas fa-user-plus text-purple-600 text-xl"></i>
                            </div>
                            <div>
                                <p class="text-gray-500 text-sm">有効会員数</p>
                                <p id="salesKpiActive" class="text-2xl font-bold text-purple-600">-</p>
                            </div>
                        </div>
                    </div>
                    <div class="bg-white rounded-xl shadow p-6">
                        <div class="flex items-center gap-4">
                            <div class="w-12 h-12 bg-orange-100 rounded-full flex items-center justify-center">
                                <i class="fas fa-sync-alt text-orange-600 text-xl"></i>
                            </div>
                            <div>
                                <p class="text-gray-500 text-sm">ARPU (平均)</p>
                                <p id="salesKpiArpu" class="text-2xl font-bold text-orange-600">-</p>
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- Monthly Chart -->
                <div class="bg-white rounded-xl shadow mb-6">
                    <div class="p-4 border-b flex items-center justify-between">
                        <h3 class="font-semibold text-gray-800">
                            <i class="fas fa-chart-bar mr-2"></i>月別売上推移
                        </h3>
                        <button onclick="loadSalesSummary()" class="px-3 py-1 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700">
                            <i class="fas fa-sync-alt mr-1"></i>更新
                        </button>
                    </div>
                    <div class="p-4 overflow-x-auto">
                        <svg id="salesMonthlyChart" width="100%" height="250"></svg>
                    </div>
                </div>
                
                <!-- Sales by Type and Top Users -->
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
                    <!-- Sales by Type -->
                    <div class="bg-white rounded-xl shadow">
                        <div class="p-4 border-b">
                            <h3 class="font-semibold text-gray-800">
                                <i class="fas fa-pie-chart mr-2"></i>決済種別内訳
                            </h3>
                        </div>
                        <div id="salesByType" class="p-4">
                            <div class="text-gray-500 text-center py-4">読み込み中...</div>
                        </div>
                    </div>
                    
                    <!-- Top Users by Revenue -->
                    <div class="bg-white rounded-xl shadow">
                        <div class="p-4 border-b">
                            <h3 class="font-semibold text-gray-800">
                                <i class="fas fa-trophy mr-2"></i>ユーザー別売上 Top 10
                            </h3>
                        </div>
                        <div class="overflow-x-auto">
                            <table class="w-full text-sm">
                                <thead class="bg-gray-50 border-b">
                                    <tr>
                                        <th class="p-3 text-left">#</th>
                                        <th class="p-3 text-left">ユーザー</th>
                                        <th class="p-3 text-right">決済回数</th>
                                        <th class="p-3 text-right">累計売上</th>
                                    </tr>
                                </thead>
                                <tbody id="salesByUserTbody">
                                    <tr><td colspan="4" class="p-4 text-center text-gray-500">読み込み中...</td></tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
                
                <!-- Recent Payments -->
                <div class="bg-white rounded-xl shadow">
                    <div class="p-4 border-b">
                        <h3 class="font-semibold text-gray-800">
                            <i class="fas fa-history mr-2"></i>直近の決済履歴
                        </h3>
                    </div>
                    <div class="overflow-x-auto">
                        <table class="w-full text-sm">
                            <thead class="bg-gray-50 border-b">
                                <tr>
                                    <th class="p-3 text-left">日時</th>
                                    <th class="p-3 text-left">ユーザー</th>
                                    <th class="p-3 text-left">種別</th>
                                    <th class="p-3 text-right">金額</th>
                                    <th class="p-3 text-left">ステータス</th>
                                </tr>
                            </thead>
                            <tbody id="salesRecordsTbody">
                                <tr><td colspan="5" class="p-4 text-center text-gray-500">読み込み中...</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
            
            <!-- Subscriptions Tab (MyASP連携課金管理) -->
            <div id="subscriptionsTab" class="hidden">
                <!-- Free Mode Banner -->
                <div id="freeModeAlert" class="mb-6 p-4 bg-green-50 border border-green-200 rounded-xl hidden">
                    <div class="flex items-center gap-3">
                        <i class="fas fa-gift text-green-600 text-xl"></i>
                        <div>
                            <p class="font-semibold text-green-800">無料開放モード有効</p>
                            <p class="text-sm text-green-700">現在、すべてのユーザーが無料でサービスを利用できます。</p>
                        </div>
                    </div>
                </div>
                
                <!-- Subscription Stats -->
                <div class="grid grid-cols-1 md:grid-cols-5 gap-4 mb-8">
                    <div class="bg-white rounded-xl shadow p-4">
                        <div class="text-xs text-gray-500">全ユーザー</div>
                        <div id="subStatTotal" class="text-2xl font-bold text-gray-900">-</div>
                    </div>
                    <div class="bg-white rounded-xl shadow p-4 border-l-4 border-gray-400">
                        <div class="text-xs text-gray-500">無料</div>
                        <div id="subStatFree" class="text-2xl font-bold text-gray-600">-</div>
                    </div>
                    <div class="bg-white rounded-xl shadow p-4 border-l-4 border-green-500">
                        <div class="text-xs text-green-700">有効</div>
                        <div id="subStatActive" class="text-2xl font-bold text-green-600">-</div>
                    </div>
                    <div class="bg-white rounded-xl shadow p-4 border-l-4 border-yellow-500">
                        <div class="text-xs text-yellow-700">停止中</div>
                        <div id="subStatSuspended" class="text-2xl font-bold text-yellow-600">-</div>
                    </div>
                    <div class="bg-white rounded-xl shadow p-4 border-l-4 border-red-500">
                        <div class="text-xs text-red-700">解約済み</div>
                        <div id="subStatCancelled" class="text-2xl font-bold text-red-600">-</div>
                    </div>
                </div>
                
                <!-- Subscriptions List -->
                <div class="bg-white rounded-xl shadow mb-6">
                    <div class="p-4 border-b flex items-center justify-between">
                        <h3 class="font-semibold text-gray-800">
                            <i class="fas fa-credit-card mr-2"></i>サブスクリプション一覧
                        </h3>
                        <button onclick="loadSubscriptions()" class="px-3 py-1 bg-purple-600 text-white rounded-lg text-sm hover:bg-purple-700">
                            <i class="fas fa-sync-alt mr-1"></i>更新
                        </button>
                    </div>
                    <div class="overflow-x-auto">
                        <table class="w-full text-sm">
                            <thead class="bg-gray-50 border-b">
                                <tr>
                                    <th class="p-3 text-left">ユーザー</th>
                                    <th class="p-3 text-left">プラン</th>
                                    <th class="p-3 text-left">ステータス</th>
                                    <th class="p-3 text-left">MyASP ID</th>
                                    <th class="p-3 text-left">開始日</th>
                                    <th class="p-3 text-left">操作</th>
                                </tr>
                            </thead>
                            <tbody id="subscriptionsTbody">
                                <tr><td colspan="6" class="p-4 text-center text-gray-500">読み込み中...</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>
                
                <!-- Recent Subscription Logs -->
                <div class="bg-white rounded-xl shadow">
                    <div class="p-4 border-b">
                        <h3 class="font-semibold text-gray-800">
                            <i class="fas fa-history mr-2"></i>直近のステータス変更
                        </h3>
                    </div>
                    <div class="overflow-x-auto">
                        <table class="w-full text-sm">
                            <thead class="bg-gray-50 border-b">
                                <tr>
                                    <th class="p-3 text-left">日時</th>
                                    <th class="p-3 text-left">ユーザー</th>
                                    <th class="p-3 text-left">変更</th>
                                    <th class="p-3 text-left">理由</th>
                                    <th class="p-3 text-left">変更者</th>
                                </tr>
                            </thead>
                            <tbody id="subscriptionLogsTbody">
                                <tr><td colspan="5" class="p-4 text-center text-gray-500">読み込み中...</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
            
            <!-- Settings Tab (システム設定) -->
            <div id="settingsTab" class="hidden">
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <!-- MyASP Settings -->
                    <div class="bg-white rounded-xl shadow">
                        <div class="p-4 border-b bg-purple-50">
                            <h3 class="font-semibold text-purple-800">
                                <i class="fas fa-link mr-2"></i>MyASP連携設定
                            </h3>
                        </div>
                        <div class="p-6 space-y-4">
                            <div>
                                <label class="block text-sm font-medium text-gray-700 mb-1">無料開放モード</label>
                                <select id="settingFreeModeEnabled" class="w-full border rounded-lg px-3 py-2">
                                    <option value="true">有効 (全員無料)</option>
                                    <option value="false">無効 (課金ユーザーのみ)</option>
                                </select>
                                <p class="text-xs text-gray-500 mt-1">有効時は全ユーザーが無料でサービスを利用可能</p>
                            </div>
                            <div>
                                <label class="block text-sm font-medium text-gray-700 mb-1">MyASPフォームURL</label>
                                <input type="text" id="settingMyaspFormUrl" class="w-full border rounded-lg px-3 py-2" placeholder="https://...">
                            </div>
                            <div>
                                <label class="block text-sm font-medium text-gray-700 mb-1">フォーム埋込みスクリプト</label>
                                <input type="text" id="settingMyaspFormScript" class="w-full border rounded-lg px-3 py-2" placeholder="https://...">
                            </div>
                            <div>
                                <label class="block text-sm font-medium text-gray-700 mb-1">月額料金 (円)</label>
                                <input type="number" id="settingSubscriptionPrice" class="w-full border rounded-lg px-3 py-2" placeholder="15000">
                            </div>
                            <div>
                                <label class="block text-sm font-medium text-gray-700 mb-1">プラン名</label>
                                <input type="text" id="settingSubscriptionPlanName" class="w-full border rounded-lg px-3 py-2" placeholder="スタンダードプラン">
                            </div>
                            <div class="pt-4 border-t">
                                <button onclick="saveMyaspSettings()" class="w-full px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700">
                                    <i class="fas fa-save mr-2"></i>MyASP設定を保存
                                </button>
                            </div>
                        </div>
                    </div>
                    
                    <!-- API Cost Settings -->
                    <div class="bg-white rounded-xl shadow">
                        <div class="p-4 border-b bg-blue-50">
                            <h3 class="font-semibold text-blue-800">
                                <i class="fas fa-calculator mr-2"></i>APIコスト設定 (USD)
                            </h3>
                        </div>
                        <div class="p-6 space-y-4">
                            <div class="grid grid-cols-2 gap-4">
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">Whisper (/ min)</label>
                                    <input type="number" step="0.001" id="settingCostWhisper" class="w-full border rounded-lg px-3 py-2 text-sm">
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">画像生成 (/ image)</label>
                                    <input type="number" step="0.001" id="settingCostImage" class="w-full border rounded-lg px-3 py-2 text-sm">
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">動画生成 (/ sec)</label>
                                    <input type="number" step="0.001" id="settingCostVideo" class="w-full border rounded-lg px-3 py-2 text-sm">
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">Chat Input (/ 1K tok)</label>
                                    <input type="number" step="0.001" id="settingCostChatInput" class="w-full border rounded-lg px-3 py-2 text-sm">
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">Chat Output (/ 1K tok)</label>
                                    <input type="number" step="0.001" id="settingCostChatOutput" class="w-full border rounded-lg px-3 py-2 text-sm">
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">Google TTS (/ 1M ch)</label>
                                    <input type="number" step="0.01" id="settingCostTtsGoogle" class="w-full border rounded-lg px-3 py-2 text-sm">
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">Fish TTS (/ 1M ch)</label>
                                    <input type="number" step="0.01" id="settingCostTtsFish" class="w-full border rounded-lg px-3 py-2 text-sm">
                                </div>
                            </div>
                            <div class="pt-4 border-t">
                                <button onclick="saveCostSettings()" class="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
                                    <i class="fas fa-save mr-2"></i>コスト設定を保存
                                </button>
                            </div>
                        </div>
                    </div>
                    
                    <!-- Webhook Status -->
                    <div class="bg-white rounded-xl shadow lg:col-span-2">
                        <div class="p-4 border-b bg-gray-50">
                            <h3 class="font-semibold text-gray-800">
                                <i class="fas fa-webhook mr-2"></i>Webhook 情報
                            </h3>
                        </div>
                        <div class="p-6">
                            <div class="mb-4">
                                <label class="block text-sm font-medium text-gray-700 mb-1">MyASP Webhook URL</label>
                                <div class="flex gap-2">
                                    <code id="webhookUrl" class="flex-1 bg-gray-100 border rounded-lg px-3 py-2 text-sm font-mono break-all"></code>
                                    <button onclick="copyWebhookUrl()" class="px-3 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700">
                                        <i class="fas fa-copy"></i>
                                    </button>
                                </div>
                                <p class="text-xs text-gray-500 mt-1">MyASPの外部連動設定でこのURLを設定してください</p>
                            </div>
                            
                            <!-- Recent Webhook Logs -->
                            <div class="mt-6">
                                <h4 class="font-medium text-gray-700 mb-3">直近のWebhookログ</h4>
                                <div class="overflow-x-auto">
                                    <table class="w-full text-sm">
                                        <thead class="bg-gray-50 border-b">
                                            <tr>
                                                <th class="p-2 text-left">日時</th>
                                                <th class="p-2 text-left">イベント</th>
                                                <th class="p-2 text-left">ステータス</th>
                                                <th class="p-2 text-left">詳細</th>
                                            </tr>
                                        </thead>
                                        <tbody id="webhookLogsTbody">
                                            <tr><td colspan="4" class="p-4 text-center text-gray-500">読み込み中...</td></tr>
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- Audio Library Tab (Phase 2: System BGM/SFX) -->
            <div id="audioLibraryTab" class="hidden">
                <div class="flex items-center justify-between mb-6">
                    <h2 class="text-lg font-bold text-gray-800">
                        <i class="fas fa-music mr-2 text-purple-600"></i>システム音声ライブラリ
                    </h2>
                    <div class="flex items-center gap-3">
                        <select id="audioLibraryTypeFilter" class="border rounded-lg px-3 py-2 text-sm" onchange="loadAudioLibrary()">
                            <option value="">すべて</option>
                            <option value="bgm">BGM</option>
                            <option value="sfx">SFX</option>
                        </select>
                        <button onclick="openAddAudioModal()" class="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm font-semibold">
                            <i class="fas fa-plus mr-1"></i>新規追加
                        </button>
                    </div>
                </div>
                
                <!-- Stats Cards -->
                <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
                    <div class="bg-white rounded-xl shadow p-4">
                        <div class="text-xs text-gray-500">総数</div>
                        <div id="audioStatTotal" class="text-2xl font-bold text-gray-900">-</div>
                    </div>
                    <div class="bg-white rounded-xl shadow p-4 border-l-4 border-purple-500">
                        <div class="text-xs text-purple-700">BGM</div>
                        <div id="audioStatBgm" class="text-2xl font-bold text-purple-700">-</div>
                    </div>
                    <div class="bg-white rounded-xl shadow p-4 border-l-4 border-blue-500">
                        <div class="text-xs text-blue-700">SFX</div>
                        <div id="audioStatSfx" class="text-2xl font-bold text-blue-700">-</div>
                    </div>
                    <div class="bg-white rounded-xl shadow p-4 border-l-4 border-green-500">
                        <div class="text-xs text-green-700">有効</div>
                        <div id="audioStatActive" class="text-2xl font-bold text-green-700">-</div>
                    </div>
                </div>
                
                <!-- Audio List -->
                <div class="bg-white rounded-xl shadow">
                    <div class="p-4 border-b flex items-center justify-between">
                        <h3 class="font-semibold text-gray-800">
                            <i class="fas fa-list mr-2"></i>登録済み音声
                        </h3>
                        <button onclick="loadAudioLibrary()" class="px-3 py-1 bg-gray-600 text-white rounded-lg text-sm hover:bg-gray-700">
                            <i class="fas fa-sync-alt mr-1"></i>更新
                        </button>
                    </div>
                    <div id="audioLibraryList" class="divide-y">
                        <div class="p-6 text-gray-500 text-center">読み込み中...</div>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Add/Edit Audio Modal -->
        <div id="addAudioModal" class="hidden fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
            <div class="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
                <div class="p-4 border-b flex items-center justify-between">
                    <h3 id="addAudioModalTitle" class="font-bold text-gray-800">
                        <i class="fas fa-music mr-2 text-purple-600"></i>音声を追加
                    </h3>
                    <button onclick="closeAddAudioModal()" class="text-gray-500 hover:text-gray-700">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="p-6 space-y-4">
                    <input type="hidden" id="editAudioId" value="">
                    
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">種別 <span class="text-red-500">*</span></label>
                        <select id="audioType" class="w-full border rounded-lg px-3 py-2">
                            <option value="bgm">BGM</option>
                            <option value="sfx">SFX</option>
                        </select>
                    </div>
                    
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">名前 <span class="text-red-500">*</span></label>
                        <input type="text" id="audioName" class="w-full border rounded-lg px-3 py-2" placeholder="明るいポップBGM">
                    </div>
                    
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">説明</label>
                        <textarea id="audioDescription" class="w-full border rounded-lg px-3 py-2" rows="2" placeholder="動画の導入に最適な明るい雰囲気のBGM"></textarea>
                    </div>
                    
                    <div class="grid grid-cols-2 gap-4">
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">カテゴリ</label>
                            <input type="text" id="audioCategory" class="w-full border rounded-lg px-3 py-2" placeholder="ポップ">
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">雰囲気 (mood)</label>
                            <select id="audioMood" class="w-full border rounded-lg px-3 py-2">
                                <option value="">選択してください</option>
                                <option value="bright">明るい</option>
                                <option value="calm">落ち着いた</option>
                                <option value="dramatic">ドラマチック</option>
                                <option value="mysterious">ミステリー</option>
                                <option value="sad">悲しい</option>
                                <option value="exciting">盛り上がる</option>
                                <option value="relaxing">リラックス</option>
                            </select>
                        </div>
                    </div>
                    
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">タグ (カンマ区切り)</label>
                        <input type="text" id="audioTags" class="w-full border rounded-lg px-3 py-2" placeholder="ポップ, 明るい, YouTube">
                    </div>
                    
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">ファイルURL <span class="text-red-500">*</span></label>
                        <div class="flex gap-2">
                            <input type="text" id="audioFileUrl" class="flex-1 border rounded-lg px-3 py-2" placeholder="https://...">
                            <label class="px-4 py-2 bg-blue-600 text-white rounded-lg cursor-pointer hover:bg-blue-700">
                                <i class="fas fa-upload mr-1"></i>アップロード
                                <input type="file" id="audioFileInput" accept="audio/*" class="hidden" onchange="handleAudioUpload(this)">
                            </label>
                        </div>
                        <div id="audioUploadProgress" class="hidden mt-2 text-sm text-blue-600">
                            <i class="fas fa-spinner fa-spin mr-1"></i>アップロード中...
                        </div>
                    </div>
                    
                    <div class="grid grid-cols-2 gap-4">
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">ファイルサイズ (bytes)</label>
                            <input type="number" id="audioFileSize" class="w-full border rounded-lg px-3 py-2" placeholder="1234567">
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">長さ (ms)</label>
                            <input type="number" id="audioDuration" class="w-full border rounded-lg px-3 py-2" placeholder="30000">
                        </div>
                    </div>
                    
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">ソース</label>
                        <select id="audioSource" class="w-full border rounded-lg px-3 py-2">
                            <option value="suno_ai">Suno AI</option>
                            <option value="manual">手動アップロード</option>
                            <option value="other">その他</option>
                        </select>
                    </div>
                    
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">並び順</label>
                        <input type="number" id="audioSortOrder" class="w-full border rounded-lg px-3 py-2" value="0">
                    </div>
                </div>
                <div class="p-4 border-t flex justify-end gap-3">
                    <button onclick="closeAddAudioModal()" class="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300">
                        キャンセル
                    </button>
                    <button onclick="saveAudio()" class="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700">
                        <i class="fas fa-save mr-1"></i>保存
                    </button>
                </div>
            </div>
        </div>
        
        <!-- Access Denied -->
        <div id="accessDenied" class="hidden text-center py-12">
            <i class="fas fa-lock text-6xl text-red-400 mb-4"></i>
            <h2 class="text-xl font-bold text-gray-800 mb-2">アクセス権限がありません</h2>
            <p class="text-gray-600 mb-6">このページはスーパー管理者のみがアクセスできます。</p>
            <a href="/" class="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
                ホームに戻る
            </a>
        </div>
    </main>
    
    <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
    <script>
        // Dollar sign constant to avoid template literal issues
        const DOLLAR = '$';
        
        let currentFilter = 'all';
        let allUsers = [];
        let subscriptionsLoaded = false;
        let settingsLoaded = false;
        let audioLibraryLoaded = false;
        let salesLoaded = false;
        
        // Check auth and load users
        async function init() {
            try {
                const res = await axios.get('/api/auth/me');
                if (!res.data.authenticated || res.data.user?.role !== 'superadmin') {
                    document.getElementById('authCheck').classList.add('hidden');
                    document.getElementById('accessDenied').classList.remove('hidden');
                    return;
                }
                
                document.getElementById('authCheck').classList.add('hidden');
                document.getElementById('adminContent').classList.remove('hidden');
                
                await loadUsers();
            } catch (err) {
                document.getElementById('authCheck').classList.add('hidden');
                document.getElementById('accessDenied').classList.remove('hidden');
            }
        }
        
        async function loadUsers() {
            try {
                const res = await axios.get('/api/admin/users');
                allUsers = res.data.users || [];
                
                // Update stats
                const pending = allUsers.filter(u => u.status === 'pending').length;
                const active = allUsers.filter(u => u.status === 'active').length;
                const suspended = allUsers.filter(u => u.status === 'suspended').length;
                
                document.getElementById('totalUsers').textContent = allUsers.length;
                document.getElementById('pendingUsers').textContent = pending;
                document.getElementById('activeUsers').textContent = active;
                document.getElementById('suspendedUsers').textContent = suspended;
                
                renderUsers();
            } catch (err) {
                document.getElementById('usersList').innerHTML = 
                    '<div class="p-6 text-red-500 text-center">ユーザーの読み込みに失敗しました</div>';
            }
        }
        
        function renderUsers() {
            const filtered = currentFilter === 'all' 
                ? allUsers 
                : allUsers.filter(u => u.status === currentFilter);
            
            const listEl = document.getElementById('usersList');
            
            if (filtered.length === 0) {
                listEl.innerHTML = '<div class="p-6 text-gray-500 text-center">ユーザーがいません</div>';
                return;
            }
            
            listEl.innerHTML = filtered.map(u => \`
                <div class="p-6 flex items-center justify-between hover:bg-gray-50" data-user-id="\${u.id}">
                    <div class="flex items-center gap-4">
                        <div class="w-12 h-12 bg-gray-200 rounded-full flex items-center justify-center">
                            <i class="fas fa-user text-gray-500 text-xl"></i>
                        </div>
                        <div>
                            <div class="font-semibold text-gray-800">\${escapeHtml(u.name)}</div>
                            <div class="text-sm text-gray-500">\${escapeHtml(u.email)}</div>
                            \${u.company ? \`<div class="text-xs text-gray-400">\${escapeHtml(u.company)}</div>\` : ''}
                        </div>
                    </div>
                    <div class="flex items-center gap-3">
                        <span class="px-3 py-1 rounded-full text-xs font-semibold \${getStatusClass(u.status)}">
                            \${getStatusLabel(u.status)}
                        </span>
                        <span class="px-3 py-1 rounded-full text-xs font-semibold \${getRoleClass(u.role)}">
                            \${u.role === 'superadmin' ? 'スーパー管理者' : '管理者'}
                        </span>
                        \${getActionButtons(u)}
                    </div>
                </div>
            \`).join('');
            
            // Bind action buttons
            listEl.querySelectorAll('.approve-btn').forEach(btn => {
                btn.addEventListener('click', () => approveUser(btn.dataset.id));
            });
            listEl.querySelectorAll('.suspend-btn').forEach(btn => {
                btn.addEventListener('click', () => suspendUser(btn.dataset.id));
            });
            listEl.querySelectorAll('.reactivate-btn').forEach(btn => {
                btn.addEventListener('click', () => reactivateUser(btn.dataset.id));
            });
            listEl.querySelectorAll('.delete-btn').forEach(btn => {
                btn.addEventListener('click', () => deleteUser(btn.dataset.id, btn.dataset.name));
            });
            listEl.querySelectorAll('.sponsor-btn').forEach(btn => {
                btn.addEventListener('click', () => toggleSponsor(btn.dataset.id, btn.dataset.sponsored === 'true'));
            });
        }
        
        function getStatusClass(status) {
            switch(status) {
                case 'pending': return 'bg-yellow-100 text-yellow-800';
                case 'active': return 'bg-green-100 text-green-800';
                case 'suspended': return 'bg-red-100 text-red-800';
                default: return 'bg-gray-100 text-gray-800';
            }
        }
        
        function getStatusLabel(status) {
            switch(status) {
                case 'pending': return '承認待ち';
                case 'active': return 'アクティブ';
                case 'suspended': return '停止中';
                default: return status;
            }
        }
        
        function getRoleClass(role) {
            return role === 'superadmin' ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800';
        }
        
        function getActionButtons(user) {
            if (user.role === 'superadmin') return '';
            
            let buttons = '';
            
            // Sponsor toggle button - allows superadmin to sponsor this user's video builds
            const isSponsored = !!user.api_sponsor_id;
            buttons += \`<button class="sponsor-btn px-3 py-1 \${isSponsored ? 'bg-purple-600' : 'bg-gray-400'} text-white rounded hover:opacity-80 text-sm" data-id="\${user.id}" data-sponsored="\${isSponsored}" title="\${isSponsored ? '動画生成スポンサー中 (クリックで解除)' : '動画生成をスポンサーする'}">\${isSponsored ? '<i class="fas fa-star"></i> スポンサー中' : '<i class="far fa-star"></i> スポンサー'}</button>\`;
            
            if (user.status === 'pending') {
                buttons += \`<button class="approve-btn px-3 py-1 bg-green-600 text-white rounded hover:bg-green-700 text-sm" data-id="\${user.id}">承認</button>\`;
            }
            if (user.status === 'active') {
                buttons += \`<button class="suspend-btn px-3 py-1 bg-yellow-600 text-white rounded hover:bg-yellow-700 text-sm" data-id="\${user.id}">停止</button>\`;
            }
            if (user.status === 'suspended') {
                buttons += \`<button class="reactivate-btn px-3 py-1 bg-green-600 text-white rounded hover:bg-green-700 text-sm" data-id="\${user.id}">再開</button>\`;
            }
            buttons += \`<button class="delete-btn px-3 py-1 bg-red-600 text-white rounded hover:bg-red-700 text-sm" data-id="\${user.id}" data-name="\${escapeHtml(user.name)}">削除</button>\`;
            return buttons;
        }
        
        function escapeHtml(s) {
            if (!s) return '';
            const div = document.createElement('div');
            div.textContent = s;
            return div.innerHTML;
        }
        
        async function approveUser(id) {
            try {
                await axios.put(\`/api/admin/users/\${id}/approve\`);
                await loadUsers();
            } catch (err) {
                alert(err.response?.data?.error?.message || '承認に失敗しました');
            }
        }
        
        async function suspendUser(id) {
            if (!confirm('このユーザーを停止しますか？')) return;
            try {
                await axios.put(\`/api/admin/users/\${id}/suspend\`);
                await loadUsers();
            } catch (err) {
                alert(err.response?.data?.error?.message || '停止に失敗しました');
            }
        }
        
        async function reactivateUser(id) {
            try {
                await axios.put(\`/api/admin/users/\${id}/reactivate\`);
                await loadUsers();
            } catch (err) {
                alert(err.response?.data?.error?.message || '再開に失敗しました');
            }
        }
        
        async function deleteUser(id, name) {
            if (!confirm(\`ユーザー "\${name}" を削除しますか？\nこの操作は取り消せません。\`)) return;
            try {
                await axios.delete(\`/api/admin/users/\${id}\`);
                await loadUsers();
            } catch (err) {
                alert(err.response?.data?.error?.message || '削除に失敗しました');
            }
        }
        
        // Filter tabs
        document.querySelectorAll('.filter-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                currentFilter = tab.dataset.filter;
                document.querySelectorAll('.filter-tab').forEach(t => {
                    t.classList.remove('border-blue-600');
                    t.classList.add('border-transparent');
                });
                tab.classList.remove('border-transparent');
                tab.classList.add('border-blue-600');
                renderUsers();
            });
        });
        
        // Admin Tab switching
        document.querySelectorAll('.admin-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const tabName = tab.dataset.tab;
                document.querySelectorAll('.admin-tab').forEach(t => {
                    t.classList.remove('border-purple-600', 'text-purple-600');
                    t.classList.add('border-transparent', 'text-gray-500');
                });
                tab.classList.remove('border-transparent', 'text-gray-500');
                tab.classList.add('border-purple-600', 'text-purple-600');
                
                document.getElementById('usersTab').classList.add('hidden');
                document.getElementById('costTab').classList.add('hidden');
                document.getElementById('videoBuildTab').classList.add('hidden');
                document.getElementById('salesTab').classList.add('hidden');
                document.getElementById('subscriptionsTab').classList.add('hidden');
                document.getElementById('settingsTab').classList.add('hidden');
                document.getElementById('audioLibraryTab')?.classList.add('hidden');
                document.getElementById(tabName + 'Tab').classList.remove('hidden');
                
                if (tabName === 'cost' && !costLoaded) {
                    loadCostData();
                }
                if (tabName === 'videoBuild' && !videoBuildLoaded) {
                    vbBuildMonthOptions();
                    loadVideoBuildSummary();
                }
                if (tabName === 'sales' && !salesLoaded) {
                    loadSalesSummary();
                    loadSalesByUser();
                    loadSalesRecords();
                }
                if (tabName === 'subscriptions' && !subscriptionsLoaded) {
                    loadSubscriptions();
                    loadSubscriptionLogs();
                }
                if (tabName === 'settings' && !settingsLoaded) {
                    loadSettings();
                    loadWebhookLogs();
                    updateWebhookUrl();
                }
                if (tabName === 'audioLibrary' && !audioLibraryLoaded) {
                    loadAudioLibrary();
                }
            });
        });
        
        // User search
        document.getElementById('userSearch').addEventListener('input', (e) => {
            const query = e.target.value.toLowerCase();
            const filtered = allUsers.filter(u => {
                if (currentFilter !== 'all' && u.status !== currentFilter) return false;
                if (!query) return true;
                return u.name.toLowerCase().includes(query) || u.email.toLowerCase().includes(query) || (u.company || '').toLowerCase().includes(query);
            });
            renderFilteredUsers(filtered);
        });
        
        function renderFilteredUsers(filtered) {
            const listEl = document.getElementById('usersList');
            if (filtered.length === 0) {
                listEl.innerHTML = '<div class="p-6 text-gray-500 text-center">該当するユーザーがいません</div>';
                return;
            }
            listEl.innerHTML = filtered.map(u => \`
                <div class="p-6 flex items-center justify-between hover:bg-gray-50" data-user-id="\${u.id}">
                    <div class="flex items-center gap-4">
                        <div class="w-12 h-12 bg-gray-200 rounded-full flex items-center justify-center">
                            <i class="fas fa-user text-gray-500 text-xl"></i>
                        </div>
                        <div>
                            <div class="font-semibold text-gray-800">\${escapeHtml(u.name)}</div>
                            <div class="text-sm text-gray-500">\${escapeHtml(u.email)}</div>
                            \${u.company ? \`<div class="text-xs text-gray-400">\${escapeHtml(u.company)}</div>\` : ''}
                        </div>
                    </div>
                    <div class="flex items-center gap-3">
                        <span class="px-3 py-1 rounded-full text-xs font-semibold \${getStatusClass(u.status)}">
                            \${getStatusLabel(u.status)}
                        </span>
                        <span class="px-3 py-1 rounded-full text-xs font-semibold \${getRoleClass(u.role)}">
                            \${u.role === 'superadmin' ? 'スーパー管理者' : '管理者'}
                        </span>
                        \${getActionButtons(u)}
                    </div>
                </div>
            \`).join('');
            bindActionButtons();
        }
        
        function bindActionButtons() {
            const listEl = document.getElementById('usersList');
            listEl.querySelectorAll('.approve-btn').forEach(btn => {
                btn.addEventListener('click', () => approveUser(btn.dataset.id));
            });
            listEl.querySelectorAll('.suspend-btn').forEach(btn => {
                btn.addEventListener('click', () => suspendUser(btn.dataset.id));
            });
            listEl.querySelectorAll('.reactivate-btn').forEach(btn => {
                btn.addEventListener('click', () => reactivateUser(btn.dataset.id));
            });
            listEl.querySelectorAll('.delete-btn').forEach(btn => {
                btn.addEventListener('click', () => deleteUser(btn.dataset.id, btn.dataset.name));
            });
            listEl.querySelectorAll('.sponsor-btn').forEach(btn => {
                btn.addEventListener('click', () => toggleSponsor(btn.dataset.id, btn.dataset.sponsored === 'true'));
            });
        }
        
        // Toggle video build sponsor
        async function toggleSponsor(userId, isCurrentlySponsored) {
            const currentUser = await axios.get('/api/auth/me').then(r => r.data.user).catch(() => null);
            if (!currentUser || currentUser.role !== 'superadmin') {
                alert('スーパー管理者のみがスポンサー設定を変更できます');
                return;
            }
            
            const newSponsorId = isCurrentlySponsored ? null : currentUser.id;
            const action = isCurrentlySponsored ? '解除' : '設定';
            
            if (!confirm(\`このユーザーの動画生成スポンサーを\${action}しますか？

\${isCurrentlySponsored ? 'スポンサー解除後、このユーザーは自分のAPI枠を使用します。' : 'スポンサー設定後、このユーザーの動画生成はあなたのAPI枠から消費されます。'}\`)) {
                return;
            }
            
            try {
                await axios.put(\`/api/admin/users/\${userId}/sponsor\`, { sponsor_id: newSponsorId });
                await loadUsers();
                alert(\`スポンサー\${action}が完了しました\`);
            } catch (err) {
                alert(err.response?.data?.error?.message || \`スポンサー\${action}に失敗しました\`);
            }
        }
        
        // Cost Dashboard
        let costLoaded = false;
        
        // Video Build Dashboard
        let videoBuildLoaded = false;
        
        function vbFormatUsd(n) {
            return Number(n || 0).toFixed(4);
        }
        
        function vbBuildMonthOptions() {
            const sel = document.getElementById('vbMonthSelect');
            if (!sel) return;
            sel.innerHTML = '';
            const now = new Date();
            for (let i = 0; i < 12; i++) {
                const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
                const yyyy = d.getFullYear();
                const mm = String(d.getMonth() + 1).padStart(2, '0');
                const opt = document.createElement('option');
                opt.value = yyyy + '-' + mm;
                opt.textContent = yyyy + '-' + mm;
                sel.appendChild(opt);
            }
        }
        
        function vbDrawDailyChart(svg, daily) {
            svg.innerHTML = '';
            const w = Number(svg.getAttribute('width')) || 900;
            const h = Number(svg.getAttribute('height')) || 220;
            const pad = 30;
            const plotW = w - pad * 2;
            const plotH = h - pad * 2;
            
            const maxY = Math.max(1, ...daily.map(d => Math.max(d.builds||0, d.completed||0, d.failed||0)));
            const x = (i) => pad + (plotW * (i / Math.max(1, daily.length - 1)));
            const y = (v) => pad + (plotH * (1 - (v / maxY)));
            
            // Axes
            const axes = document.createElementNS('http://www.w3.org/2000/svg','path');
            axes.setAttribute('d', 'M ' + pad + ' ' + pad + ' L ' + pad + ' ' + (h-pad) + ' L ' + (w-pad) + ' ' + (h-pad));
            axes.setAttribute('stroke', '#9ca3af');
            axes.setAttribute('fill', 'none');
            svg.appendChild(axes);
            
            const lines = [
                { key: 'builds', stroke: '#111827', label: 'builds' },
                { key: 'completed', stroke: '#16a34a', label: 'completed' },
                { key: 'failed', stroke: '#dc2626', label: 'failed' },
            ];
            
            lines.forEach((ln, idx) => {
                if (!daily.length) return;
                const pathData = daily.map((d, i) => (i === 0 ? 'M' : 'L') + ' ' + x(i) + ' ' + y(d[ln.key]||0)).join(' ');
                const p = document.createElementNS('http://www.w3.org/2000/svg','path');
                p.setAttribute('d', pathData);
                p.setAttribute('stroke', ln.stroke);
                p.setAttribute('fill', 'none');
                p.setAttribute('stroke-width', '2');
                svg.appendChild(p);
                
                const t = document.createElementNS('http://www.w3.org/2000/svg','text');
                t.setAttribute('x', String(pad + idx*120));
                t.setAttribute('y', String(pad - 10));
                t.setAttribute('fill', ln.stroke);
                t.setAttribute('font-size', '12');
                t.textContent = ln.label;
                svg.appendChild(t);
            });
            
            const label = document.createElementNS('http://www.w3.org/2000/svg','text');
            label.setAttribute('x', String(pad));
            label.setAttribute('y', String(h - 8));
            label.setAttribute('fill', '#6b7280');
            label.setAttribute('font-size', '11');
            label.textContent = daily.length ? daily[0].date + ' ... ' + daily[daily.length-1].date : '';
            svg.appendChild(label);
        }
        
        async function loadVideoBuildSummary() {
            try {
                const sel = document.getElementById('vbMonthSelect');
                const period = sel?.value || null;
                const [year, month] = period ? period.split('-') : [null, null];
                const qs = (year && month) ? '?year=' + encodeURIComponent(year) + '&month=' + encodeURIComponent(month) : '';
                
                const res = await axios.get('/api/admin/video-builds/summary' + qs);
                const data = res.data;
                videoBuildLoaded = true;
                
                // KPI
                document.getElementById('vbKpiTotal').textContent = data.totals?.builds ?? 0;
                document.getElementById('vbKpiCompleted').textContent = data.totals?.completed ?? 0;
                document.getElementById('vbKpiFailed').textContent = data.totals?.failed ?? 0;
                document.getElementById('vbKpiRetrying').textContent = data.totals?.retry_wait ?? 0;
                document.getElementById('vbKpiCost').textContent = '\$' + vbFormatUsd(data.totals?.estimated_cost_usd);
                
                // Daily Chart
                const svg = document.getElementById('vbDailyChart');
                if (svg) vbDrawDailyChart(svg, data.daily || []);
                
                // By Owner
                const ownerT = document.getElementById('vbByOwnerTbody');
                if (ownerT) {
                    const owners = data.by_owner || [];
                    if (owners.length === 0) {
                        ownerT.innerHTML = '<tr><td colspan="5" class="p-4 text-gray-500 text-center">データなし</td></tr>';
                    } else {
                        ownerT.innerHTML = owners.map(r => '<tr class="border-b hover:bg-gray-50">' +
                            '<td class="p-3"><div class="font-semibold">' + escapeHtml(r.owner_name || 'Unknown') + '</div><div class="text-xs text-gray-500">' + escapeHtml(r.owner_email || '') + '</div></td>' +
                            '<td class="p-3 text-right">' + (r.builds ?? 0) + '</td>' +
                            '<td class="p-3 text-right text-green-700">' + (r.completed ?? 0) + '</td>' +
                            '<td class="p-3 text-right text-red-700">' + (r.failed ?? 0) + '</td>' +
                            '<td class="p-3 text-right">\$' + vbFormatUsd(r.estimated_cost_usd) + '</td>' +
                        '</tr>').join('');
                    }
                }
                
                // By Executor
                const execT = document.getElementById('vbByExecutorTbody');
                if (execT) {
                    const execs = data.by_executor || [];
                    if (execs.length === 0) {
                        execT.innerHTML = '<tr><td colspan="4" class="p-4 text-gray-500 text-center">データなし</td></tr>';
                    } else {
                        execT.innerHTML = execs.map(r => '<tr class="border-b hover:bg-gray-50">' +
                            '<td class="p-3"><div class="font-semibold">' + escapeHtml(r.executor_name || 'Unknown') + '</div><div class="text-xs text-gray-500">' + escapeHtml(r.executor_email || '') + '</div></td>' +
                            '<td class="p-3 text-right">' + (r.total_builds ?? 0) + '</td>' +
                            '<td class="p-3 text-right text-purple-700">' + (r.delegated_builds ?? 0) + '</td>' +
                            '<td class="p-3 text-right">\$' + vbFormatUsd(r.estimated_cost_usd) + '</td>' +
                        '</tr>').join('');
                    }
                }
                
                // Recent Failed
                const failT = document.getElementById('vbRecentFailedTbody');
                if (failT) {
                    const fails = data.recent_failed || [];
                    if (fails.length === 0) {
                        failT.innerHTML = '<tr><td colspan="4" class="p-4 text-green-600 text-center"><i class="fas fa-check-circle mr-2"></i>直近の失敗なし</td></tr>';
                    } else {
                        failT.innerHTML = fails.map(r => '<tr class="border-b hover:bg-gray-50">' +
                            '<td class="p-3 font-mono">#' + r.id + '</td>' +
                            '<td class="p-3">' + escapeHtml(r.owner_email || '') + '</td>' +
                            '<td class="p-3"><div class="text-xs font-semibold text-red-700">' + escapeHtml(r.error_code || 'FAILED') + '</div><div class="text-xs text-red-600 truncate max-w-xs" title="' + escapeHtml(r.error_message || '') + '">' + escapeHtml((r.error_message || '').slice(0, 80)) + '</div></td>' +
                            '<td class="p-3 text-xs text-gray-500">' + escapeHtml(r.created_at || '') + '</td>' +
                        '</tr>').join('');
                    }
                }
            } catch (err) {
                console.error('Failed to load video build summary:', err);
                document.getElementById('vbKpiTotal').textContent = 'Error';
            }
        }
        
        async function loadCostData() {
            try {
                const days = document.getElementById('costDaysSelect')?.value || '30';
                
                // Load summary and daily data in parallel
                const [summaryRes, dailyRes] = await Promise.all([
                    axios.get('/api/admin/usage'),
                    axios.get('/api/admin/usage/daily?days=' + days)
                ]);
                
                const data = summaryRes.data;
                const dailyData = dailyRes.data;
                costLoaded = true;
                
                // Draw daily chart
                drawCostDailyChart(document.getElementById('costDailyChart'), dailyData.data || []);
                
                // Update summary cards with JPY conversion
                const totalUsd = data.totalCost || 0;
                const totalJpy = totalUsd * USD_JPY_RATE;
                document.getElementById('totalCost').innerHTML = '\$' + totalUsd.toFixed(4) + '<br><span class="text-sm text-gray-500">¥' + totalJpy.toFixed(0) + '</span>';
                document.getElementById('totalRequests').textContent = (data.totalRequests || 0).toLocaleString();
                const typeCount = Object.keys(data.byType || {}).length;
                document.getElementById('apiTypeCount').textContent = typeCount + '種類';
                
                // Render cost by type
                const typeEl = document.getElementById('costByType');
                const byTypeArr = Object.entries(data.byType || {}).map(([api_type, info]) => ({
                    api_type,
                    total_cost: info.cost,
                    request_count: info.count
                })).filter(t => t.request_count > 0);
                
                if (byTypeArr.length > 0) {
                    const maxCost = Math.max(...byTypeArr.map(t => t.total_cost || 0), 0.001);
                    typeEl.innerHTML = byTypeArr.map(t => {
                        const costUsd = t.total_cost || 0;
                        const costJpy = costUsd * USD_JPY_RATE;
                        return \`
                        <div class="mb-4">
                            <div class="flex justify-between mb-1">
                                <span class="font-medium text-gray-700">\${getApiTypeLabel(t.api_type)}</span>
                                <span class="text-gray-600">$$\${costUsd.toFixed(4)} (¥\${costJpy.toFixed(0)}) / \${t.request_count || 0}回</span>
                            </div>
                            <div class="w-full bg-gray-200 rounded-full h-3">
                                <div class="bg-purple-600 h-3 rounded-full" style="width: \${(costUsd / maxCost * 100).toFixed(1)}%"></div>
                            </div>
                        </div>
                    \`}).join('');
                } else {
                    typeEl.innerHTML = '<div class="text-gray-500 text-center py-4">APIコストデータがありません</div>';
                }
                
                // Render cost by user (運営負担分のみ)
                const userEl = document.getElementById('costByUser');
                const byUserArr = (data.byUser || []).filter(u => u.requestCount > 0);
                if (byUserArr.length > 0) {
                    userEl.innerHTML = byUserArr.slice(0, 10).map((u, idx) => {
                        const uCostUsd = u.totalCost || 0;
                        const uCostJpy = uCostUsd * USD_JPY_RATE;
                        return \`
                        <div class="p-4 flex items-center justify-between hover:bg-red-50">
                            <div class="flex items-center gap-4">
                                <div class="w-8 h-8 bg-red-100 rounded-full flex items-center justify-center text-red-600 font-bold text-sm">
                                    \${idx + 1}
                                </div>
                                <div>
                                    <div class="font-medium text-gray-800">\${escapeHtml(u.name || 'Unknown')}</div>
                                    <div class="text-sm text-gray-500">\${escapeHtml(u.email || '')}</div>
                                </div>
                            </div>
                            <div class="text-right">
                                <div class="font-bold text-red-700">$$\${uCostUsd.toFixed(4)}</div>
                                <div class="text-xs text-gray-500">¥\${uCostJpy.toFixed(0)}</div>
                                <div class="text-sm text-gray-500">\${u.requestCount || 0}リクエスト</div>
                            </div>
                        </div>
                    \`}).join('');
                } else {
                    userEl.innerHTML = '<div class="p-6 text-green-600 text-center"><i class="fas fa-check-circle mr-2"></i>運営負担コストはありません（全てユーザー負担）</div>';
                }
                
                // Render cost by user (全体: 参考値)
                const userElAll = document.getElementById('costByUserAll');
                const byUserAllArr = (data.byUserAll || []).filter(u => u.requestCount > 0);
                if (byUserAllArr.length > 0) {
                    userElAll.innerHTML = byUserAllArr.slice(0, 10).map((u, idx) => {
                        const uCostUsd = u.totalCost || 0;
                        const uCostJpy = uCostUsd * USD_JPY_RATE;
                        const sponsoredCost = u.sponsoredCost || 0;
                        const userCost = u.userCost || 0;
                        return \`
                        <div class="p-4 flex items-center justify-between hover:bg-gray-100">
                            <div class="flex items-center gap-4">
                                <div class="w-8 h-8 bg-gray-200 rounded-full flex items-center justify-center text-gray-600 font-bold text-sm">
                                    \${idx + 1}
                                </div>
                                <div>
                                    <div class="font-medium text-gray-700">\${escapeHtml(u.name || 'Unknown')}</div>
                                    <div class="text-sm text-gray-500">\${escapeHtml(u.email || '')}</div>
                                </div>
                            </div>
                            <div class="text-right">
                                <div class="font-bold text-gray-700">$$\${uCostUsd.toFixed(4)}</div>
                                <div class="text-xs text-gray-500">¥\${uCostJpy.toFixed(0)}</div>
                                <div class="text-xs mt-1">
                                    <span class="text-red-600" title="運営負担">$$\${sponsoredCost.toFixed(4)}</span>
                                    <span class="text-gray-400 mx-1">/</span>
                                    <span class="text-blue-600" title="ユーザー負担">$$\${userCost.toFixed(4)}</span>
                                </div>
                                <div class="text-xs text-gray-400">\${u.requestCount || 0}リクエスト</div>
                            </div>
                        </div>
                    \`}).join('');
                } else {
                    userElAll.innerHTML = '<div class="p-6 text-gray-500 text-center">利用データがありません</div>';
                }
                
                // Load sponsor usage data
                loadSponsorUsage();
                // Load operations usage data (Safe Chat v1)
                loadOperationsUsage();
                
            } catch (err) {
                console.error('Failed to load cost data:', err);
                document.getElementById('costByType').innerHTML = '<div class="text-red-500 text-center py-4">コストデータの読み込みに失敗しました</div>';
                document.getElementById('costByUser').innerHTML = '<div class="p-6 text-red-500 text-center">コストデータの読み込みに失敗しました</div>';
            }
        }
        
        function getApiTypeLabel(type) {
            const labels = {
                'whisper': '音声認識 (Whisper)',
                'chat_completion': 'チャット補完 (GPT)',
                'image_generation': '画像生成 (Gemini)',
                'tts_google': '音声合成 (Google TTS)',
                'tts_fish': '音声合成 (Fish Audio)',
                'video_generation': '動画生成',
                'video_build': '動画ビルド (Remotion)'
            };
            return labels[type] || type;
        }
        
        // USD to JPY conversion rate (approximate, updated periodically)
        const USD_JPY_RATE = 155; // 1 USD = 155 JPY (2024年レート目安)
        
        function formatCost(usd) {
            const usdVal = Number(usd) || 0;
            const jpyVal = usdVal * USD_JPY_RATE;
            return \`$$\${usdVal.toFixed(4)} (¥\${jpyVal.toFixed(0)})\`;
        }
        
        function formatCostShort(usd) {
            const usdVal = Number(usd) || 0;
            const jpyVal = usdVal * USD_JPY_RATE;
            return \`$$\${usdVal.toFixed(4)}<br><span class="text-xs text-gray-500">¥\${jpyVal.toFixed(0)}</span>\`;
        }
        
        // Load sponsor usage data
        async function loadSponsorUsage() {
            const el = document.getElementById('sponsorUsage');
            if (!el) return;
            
            try {
                const res = await axios.get('/api/admin/usage/sponsor');
                const data = res.data;
                
                if (!data.sponsors || data.sponsors.length === 0) {
                    el.innerHTML = \`
                        <div class="text-gray-500 text-center py-8">
                            <i class="fas fa-star text-4xl text-gray-300 mb-4"></i>
                            <p>スポンサー使用データがありません</p>
                            <p class="text-sm mt-2">ユーザーにスポンサーを設定すると、ここに使用量が表示されます</p>
                        </div>
                    \`;
                    return;
                }
                
                const grandUsd = data.grandTotalCost || 0;
                const grandJpy = grandUsd * USD_JPY_RATE;
                let html = \`
                    <div class="mb-4 p-4 bg-yellow-50 rounded-lg">
                        <div class="flex items-center gap-4">
                            <div class="text-yellow-600">
                                <i class="fas fa-star text-2xl"></i>
                            </div>
                            <div>
                                <p class="text-lg font-bold text-yellow-800">スポンサー総コスト: $$\${grandUsd.toFixed(4)} (¥\${grandJpy.toFixed(0)})</p>
                                <p class="text-sm text-yellow-700">総リクエスト数: \${data.grandTotalRequests || 0}件</p>
                            </div>
                        </div>
                    </div>
                \`;
                
                for (const sponsor of data.sponsors) {
                    const spUsd = sponsor.totalCost || 0;
                    const spJpy = spUsd * USD_JPY_RATE;
                    html += \`
                        <div class="mb-6 border rounded-lg overflow-hidden">
                            <div class="bg-purple-50 p-4 flex items-center justify-between">
                                <div class="flex items-center gap-3">
                                    <div class="w-10 h-10 bg-purple-200 rounded-full flex items-center justify-center">
                                        <i class="fas fa-crown text-purple-600"></i>
                                    </div>
                                    <div>
                                        <div class="font-bold text-purple-800">\${escapeHtml(sponsor.sponsor.name)}</div>
                                        <div class="text-sm text-purple-600">\${escapeHtml(sponsor.sponsor.email)}</div>
                                    </div>
                                </div>
                                <div class="text-right">
                                    <div class="text-lg font-bold text-purple-800">$$\${spUsd.toFixed(4)}</div>
                                    <div class="text-xs text-purple-600">¥\${spJpy.toFixed(0)}</div>
                                    <div class="text-sm text-purple-600">\${sponsor.totalRequests || 0}リクエスト</div>
                                </div>
                            </div>
                            <div class="divide-y">
                    \`;
                    
                    for (const user of sponsor.byUser) {
                        const userUsd = user.totalCost || 0;
                        const userJpy = userUsd * USD_JPY_RATE;
                        const types = Object.entries(user.byType || {}).map(([type, info]) => {
                            const tJpy = (info.cost || 0) * USD_JPY_RATE;
                            return \`<span class="text-xs bg-gray-100 px-2 py-1 rounded mr-1">\${getApiTypeLabel(type)}: $$\${info.cost.toFixed(4)} (¥\${tJpy.toFixed(0)})</span>\`;
                        }).join('');
                        
                        html += \`
                            <div class="p-4 hover:bg-gray-50 flex items-center justify-between">
                                <div class="flex items-center gap-3">
                                    <div class="w-8 h-8 bg-gray-200 rounded-full flex items-center justify-center">
                                        <i class="fas fa-user text-gray-500 text-sm"></i>
                                    </div>
                                    <div>
                                        <div class="font-medium text-gray-800">\${escapeHtml(user.user.name)}</div>
                                        <div class="text-sm text-gray-500">\${escapeHtml(user.user.email)}</div>
                                        <div class="mt-1">\${types}</div>
                                    </div>
                                </div>
                                <div class="text-right">
                                    <div class="font-bold text-gray-800">$$\${userUsd.toFixed(4)}</div>
                                    <div class="text-xs text-gray-500">¥\${userJpy.toFixed(0)}</div>
                                    <div class="text-sm text-gray-500">\${user.totalRequests || 0}リクエスト</div>
                                </div>
                            </div>
                        \`;
                    }
                    
                    html += '</div></div>';
                }
                
                el.innerHTML = html;
                
            } catch (err) {
                console.error('Failed to load sponsor usage:', err);
                // Show "no data" instead of error if it's likely just empty data
                if (err.response && err.response.status === 200) {
                    el.innerHTML = \`
                        <div class="text-gray-500 text-center py-8">
                            <i class="fas fa-star text-4xl text-gray-300 mb-4"></i>
                            <p>スポンサー使用データがありません</p>
                        </div>
                    \`;
                } else {
                    el.innerHTML = \`
                        <div class="text-gray-500 text-center py-8">
                            <i class="fas fa-star text-4xl text-gray-300 mb-4"></i>
                            <p>スポンサー使用データがありません</p>
                            <p class="text-sm mt-2">ユーザーにスポンサーを設定し、API使用があるとここに表示されます</p>
                        </div>
                    \`;
                }
            }
        }
        
        // Load operations usage data (Safe Chat v1)
        async function loadOperationsUsage() {
            const el = document.getElementById('operationsUsage');
            const recentEl = document.getElementById('recentOperations');
            if (!el) return;
            
            try {
                const days = document.getElementById('costDaysSelect')?.value || '30';
                const res = await axios.get('/api/admin/usage/operations?days=' + days);
                const data = res.data;
                
                const summary = data.summary || { totalOperations: 0, totalCost: 0, periodDays: 30 };
                const byType = data.byType || {};
                
                // Operation type labels
                const opTypeLabels = {
                    'bgm_upload': { label: 'BGMアップロード', icon: 'fas fa-music', color: 'purple' },
                    'sfx_upload': { label: 'SFXアップロード', icon: 'fas fa-volume-up', color: 'blue' },
                    'patch_dry_run': { label: 'パッチDry-run (API)', icon: 'fas fa-code', color: 'gray' },
                    'patch_apply': { label: 'パッチ適用 (API)', icon: 'fas fa-check-circle', color: 'green' },
                    'chat_edit_dry_run': { label: 'チャット修正Dry-run', icon: 'fas fa-comments', color: 'indigo' },
                    'chat_edit_apply': { label: 'チャット修正適用', icon: 'fas fa-comment-dots', color: 'teal' },
                    'video_build_render': { label: 'ビデオレンダリング', icon: 'fas fa-film', color: 'red' },
                    'llm_intent': { label: 'LLM Intent生成', icon: 'fas fa-brain', color: 'pink' },
                };
                
                if (Object.keys(byType).length === 0) {
                    el.innerHTML = \`
                        <div class="text-gray-500 text-center py-8">
                            <i class="fas fa-cogs text-4xl text-gray-300 mb-4"></i>
                            <p>オペレーションデータがありません</p>
                            <p class="text-sm mt-2">BGM/SFXアップロード、パッチ適用などを行うとここに表示されます</p>
                        </div>
                    \`;
                } else {
                    let html = \`
                        <div class="mb-4 p-4 bg-indigo-50 rounded-lg">
                            <div class="flex items-center gap-4">
                                <div class="text-indigo-600">
                                    <i class="fas fa-cogs text-2xl"></i>
                                </div>
                                <div>
                                    <p class="text-lg font-bold text-indigo-800">総オペレーション: \${summary.totalOperations}件</p>
                                    <p class="text-sm text-indigo-700">推定コスト: $$\${(summary.totalCost || 0).toFixed(4)} (過去\${summary.periodDays}日)</p>
                                </div>
                            </div>
                        </div>
                        <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
                    \`;
                    
                    for (const [opType, info] of Object.entries(byType)) {
                        const opLabel = opTypeLabels[opType] || { label: opType, icon: 'fas fa-question', color: 'gray' };
                        html += \`
                            <div class="p-4 bg-\${opLabel.color}-50 rounded-lg">
                                <div class="flex items-center gap-2 mb-2">
                                    <i class="\${opLabel.icon} text-\${opLabel.color}-600"></i>
                                    <span class="text-sm font-medium text-\${opLabel.color}-800">\${opLabel.label}</span>
                                </div>
                                <div class="text-2xl font-bold text-\${opLabel.color}-700">\${info.count || 0}</div>
                                <div class="text-xs text-\${opLabel.color}-600">
                                    \${info.projects || 0}プロジェクト / \${info.users || 0}ユーザー
                                </div>
                            </div>
                        \`;
                    }
                    
                    html += '</div>';
                    el.innerHTML = html;
                }
                
                // Recent operations
                const recentOps = data.recentOperations || [];
                if (recentEl) {
                    if (recentOps.length === 0) {
                        recentEl.innerHTML = '<div class="text-gray-500 text-center py-4">最近のオペレーションはありません</div>';
                    } else {
                        let recentHtml = '';
                        for (const op of recentOps.slice(0, 20)) {
                            const opLabel = opTypeLabels[op.type] || { label: op.type, icon: 'fas fa-question', color: 'gray' };
                            const time = new Date(op.createdAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
                            recentHtml += \`
                                <div class="flex items-center justify-between p-2 hover:bg-gray-50 rounded text-sm">
                                    <div class="flex items-center gap-2">
                                        <i class="\${opLabel.icon} text-\${opLabel.color}-500"></i>
                                        <span class="font-medium">\${opLabel.label}</span>
                                        <span class="text-gray-500">- \${escapeHtml(op.project || '-')}</span>
                                    </div>
                                    <div class="flex items-center gap-4">
                                        <span class="text-gray-600">\${escapeHtml(op.user || '-')}</span>
                                        <span class="text-gray-400 text-xs">\${time}</span>
                                    </div>
                                </div>
                            \`;
                        }
                        recentEl.innerHTML = recentHtml;
                    }
                }
                
            } catch (err) {
                console.error('Failed to load operations usage:', err);
                el.innerHTML = \`
                    <div class="text-gray-500 text-center py-8">
                        <i class="fas fa-cogs text-4xl text-gray-300 mb-4"></i>
                        <p>オペレーションデータがありません</p>
                    </div>
                \`;
            }
        }
        
        function drawCostDailyChart(svg, daily) {
            if (!svg) return;
            svg.innerHTML = '';
            const w = Number(svg.getAttribute('width')) || 900;
            const h = Number(svg.getAttribute('height')) || 220;
            const pad = 40;
            const plotW = w - pad * 2;
            const plotH = h - pad * 2;
            
            if (!daily || daily.length === 0) {
                const t = document.createElementNS('http://www.w3.org/2000/svg','text');
                t.setAttribute('x', String(w/2));
                t.setAttribute('y', String(h/2));
                t.setAttribute('text-anchor', 'middle');
                t.setAttribute('fill', '#9ca3af');
                t.textContent = 'データがありません';
                svg.appendChild(t);
                return;
            }
            
            const maxY = Math.max(0.001, ...daily.map(d => d.cost || 0));
            const x = (i) => pad + (plotW * (i / Math.max(1, daily.length - 1)));
            const y = (v) => pad + (plotH * (1 - (v / maxY)));
            
            // Axes
            const axes = document.createElementNS('http://www.w3.org/2000/svg','path');
            axes.setAttribute('d', 'M ' + pad + ' ' + pad + ' L ' + pad + ' ' + (h-pad) + ' L ' + (w-pad) + ' ' + (h-pad));
            axes.setAttribute('stroke', '#9ca3af');
            axes.setAttribute('fill', 'none');
            svg.appendChild(axes);
            
            // Y-axis labels
            for (let i = 0; i <= 4; i++) {
                const yVal = (maxY * (4 - i) / 4);
                const yPos = pad + (plotH * i / 4);
                const label = document.createElementNS('http://www.w3.org/2000/svg','text');
                label.setAttribute('x', String(pad - 5));
                label.setAttribute('y', String(yPos + 4));
                label.setAttribute('text-anchor', 'end');
                label.setAttribute('fill', '#6b7280');
                label.setAttribute('font-size', '10');
                label.textContent = '\$' + yVal.toFixed(3);
                svg.appendChild(label);
            }
            
            // Total cost line
            const pathData = daily.map((d, i) => (i === 0 ? 'M' : 'L') + ' ' + x(i) + ' ' + y(d.cost || 0)).join(' ');
            const p = document.createElementNS('http://www.w3.org/2000/svg','path');
            p.setAttribute('d', pathData);
            p.setAttribute('stroke', '#16a34a');
            p.setAttribute('fill', 'none');
            p.setAttribute('stroke-width', '2');
            svg.appendChild(p);
            
            // Area fill
            const areaPath = pathData + ' L ' + x(daily.length - 1) + ' ' + (h - pad) + ' L ' + pad + ' ' + (h - pad) + ' Z';
            const area = document.createElementNS('http://www.w3.org/2000/svg','path');
            area.setAttribute('d', areaPath);
            area.setAttribute('fill', 'rgba(22, 163, 74, 0.1)');
            svg.appendChild(area);
            
            // Data points
            daily.forEach((d, i) => {
                const circle = document.createElementNS('http://www.w3.org/2000/svg','circle');
                circle.setAttribute('cx', String(x(i)));
                circle.setAttribute('cy', String(y(d.cost || 0)));
                circle.setAttribute('r', '4');
                circle.setAttribute('fill', '#16a34a');
                svg.appendChild(circle);
            });
            
            // X-axis labels (first, middle, last)
            if (daily.length > 0) {
                [0, Math.floor(daily.length / 2), daily.length - 1].forEach(idx => {
                    if (idx >= daily.length) return;
                    const label = document.createElementNS('http://www.w3.org/2000/svg','text');
                    label.setAttribute('x', String(x(idx)));
                    label.setAttribute('y', String(h - 10));
                    label.setAttribute('text-anchor', 'middle');
                    label.setAttribute('fill', '#6b7280');
                    label.setAttribute('font-size', '10');
                    label.textContent = daily[idx].date || '';
                    svg.appendChild(label);
                });
            }
            
            // Legend
            const legend = document.createElementNS('http://www.w3.org/2000/svg','text');
            legend.setAttribute('x', String(pad));
            legend.setAttribute('y', String(pad - 10));
            legend.setAttribute('fill', '#16a34a');
            legend.setAttribute('font-size', '12');
            legend.textContent = '日別コスト (USD)';
            svg.appendChild(legend);
        }
        
        // Logout
        document.getElementById('logoutBtn').addEventListener('click', async () => {
            await axios.post('/api/auth/logout');
            window.location.href = '/login';
        });
        
        // ============================================
        // Subscriptions Tab Functions
        // ============================================
        const SUB_STATUS_LABELS = {
            0: { label: '無料', class: 'bg-gray-100 text-gray-800' },
            1: { label: '有効', class: 'bg-green-100 text-green-800' },
            2: { label: '停止', class: 'bg-yellow-100 text-yellow-800' },
            3: { label: '復活', class: 'bg-blue-100 text-blue-800' },
            4: { label: '解約', class: 'bg-red-100 text-red-800' },
        };
        
        async function loadSubscriptions() {
            try {
                const res = await axios.get('/api/admin/subscriptions');
                const users = res.data.users || [];
                subscriptionsLoaded = true;
                
                // Update stats
                const free = users.filter(u => u.subscription.status === 0).length;
                const active = users.filter(u => u.subscription.status === 1).length;
                const suspended = users.filter(u => u.subscription.status === 2).length;
                const cancelled = users.filter(u => u.subscription.status === 4).length;
                
                document.getElementById('subStatTotal').textContent = users.length;
                document.getElementById('subStatFree').textContent = free;
                document.getElementById('subStatActive').textContent = active;
                document.getElementById('subStatSuspended').textContent = suspended;
                document.getElementById('subStatCancelled').textContent = cancelled;
                
                // Render table
                const tbody = document.getElementById('subscriptionsTbody');
                if (users.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="6" class="p-4 text-center text-gray-500">ユーザーがいません</td></tr>';
                    return;
                }
                
                tbody.innerHTML = users.map(u => \`
                    <tr class="border-b hover:bg-gray-50">
                        <td class="p-3">
                            <div class="font-medium">\${escapeHtml(u.name)}</div>
                            <div class="text-xs text-gray-500">\${escapeHtml(u.email)}</div>
                        </td>
                        <td class="p-3">\${escapeHtml(u.subscription.plan)}</td>
                        <td class="p-3">
                            <span class="px-2 py-1 rounded-full text-xs font-medium \${SUB_STATUS_LABELS[u.subscription.status]?.class || 'bg-gray-100'}">
                                \${SUB_STATUS_LABELS[u.subscription.status]?.label || '不明'}
                            </span>
                        </td>
                        <td class="p-3 text-xs text-gray-500">\${u.subscription.myasp_user_id || '-'}</td>
                        <td class="p-3 text-xs text-gray-500">\${u.subscription.started_at ? new Date(u.subscription.started_at).toLocaleDateString('ja-JP') : '-'}</td>
                        <td class="p-3">
                            <select onchange="updateSubscriptionStatus(\${u.id}, this.value)" class="text-xs border rounded px-2 py-1">
                                <option value="0" \${u.subscription.status === 0 ? 'selected' : ''}>無料</option>
                                <option value="1" \${u.subscription.status === 1 ? 'selected' : ''}>有効</option>
                                <option value="2" \${u.subscription.status === 2 ? 'selected' : ''}>停止</option>
                                <option value="4" \${u.subscription.status === 4 ? 'selected' : ''}>解約</option>
                            </select>
                        </td>
                    </tr>
                \`).join('');
                
            } catch (err) {
                console.error('Failed to load subscriptions:', err);
                document.getElementById('subscriptionsTbody').innerHTML = 
                    '<tr><td colspan="6" class="p-4 text-center text-red-500">読み込みに失敗しました</td></tr>';
            }
        }
        
        async function updateSubscriptionStatus(userId, newStatus) {
            if (!confirm('サブスクリプションステータスを変更しますか？')) {
                loadSubscriptions();
                return;
            }
            
            try {
                await axios.put('/api/admin/subscriptions/' + userId, {
                    subscription_status: parseInt(newStatus),
                    reason: 'Manual update by superadmin'
                });
                alert('ステータスを更新しました');
                loadSubscriptions();
                loadSubscriptionLogs();
            } catch (err) {
                console.error('Failed to update subscription:', err);
                alert('更新に失敗しました: ' + (err.response?.data?.error?.message || err.message));
                loadSubscriptions();
            }
        }
        
        async function loadSubscriptionLogs() {
            try {
                const res = await axios.get('/api/admin/subscription-logs?limit=20');
                const logs = res.data.logs || [];
                
                const tbody = document.getElementById('subscriptionLogsTbody');
                if (logs.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-gray-500">ログがありません</td></tr>';
                    return;
                }
                
                tbody.innerHTML = logs.map(log => \`
                    <tr class="border-b">
                        <td class="p-3 text-xs text-gray-500">\${new Date(log.created_at).toLocaleString('ja-JP')}</td>
                        <td class="p-3">
                            <div class="text-sm">\${escapeHtml(log.user.name)}</div>
                            <div class="text-xs text-gray-500">\${escapeHtml(log.user.email)}</div>
                        </td>
                        <td class="p-3">
                            <span class="text-xs">\${log.previous_status}</span>
                            <i class="fas fa-arrow-right mx-1 text-gray-400"></i>
                            <span class="text-xs font-medium">\${log.new_status}</span>
                        </td>
                        <td class="p-3 text-xs text-gray-600">\${escapeHtml(log.change_reason)}</td>
                        <td class="p-3 text-xs text-gray-500">\${escapeHtml(log.changed_by)}</td>
                    </tr>
                \`).join('');
                
            } catch (err) {
                console.error('Failed to load subscription logs:', err);
                document.getElementById('subscriptionLogsTbody').innerHTML = 
                    '<tr><td colspan="5" class="p-4 text-center text-red-500">読み込みに失敗しました</td></tr>';
            }
        }
        
        // ============================================
        // Settings Tab Functions
        // ============================================
        async function loadSettings() {
            try {
                const res = await axios.get('/api/admin/settings');
                const settings = res.data.settings || {};
                settingsLoaded = true;
                
                // MyASP settings
                document.getElementById('settingFreeModeEnabled').value = settings['free_mode_enabled']?.value || 'true';
                document.getElementById('settingMyaspFormUrl').value = settings['myasp_form_url']?.value || '';
                document.getElementById('settingMyaspFormScript').value = settings['myasp_form_script']?.value || '';
                document.getElementById('settingSubscriptionPrice').value = settings['subscription_monthly_price']?.value || '15000';
                document.getElementById('settingSubscriptionPlanName').value = settings['subscription_plan_name']?.value || '';
                
                // Cost settings
                document.getElementById('settingCostWhisper').value = settings['cost_whisper_per_minute']?.value || '0.006';
                document.getElementById('settingCostImage').value = settings['cost_image_generation_per_image']?.value || '0.02';
                document.getElementById('settingCostVideo').value = settings['cost_video_generation_per_second']?.value || '0.05';
                document.getElementById('settingCostChatInput').value = settings['cost_chat_input_per_1k_tokens']?.value || '0.01';
                document.getElementById('settingCostChatOutput').value = settings['cost_chat_output_per_1k_tokens']?.value || '0.03';
                document.getElementById('settingCostTtsGoogle').value = settings['cost_tts_google_per_1m_chars']?.value || '16';
                document.getElementById('settingCostTtsFish').value = settings['cost_tts_fish_per_1m_chars']?.value || '20';
                
                // Update free mode banner
                const freeModeEnabled = settings['free_mode_enabled']?.value === 'true';
                const freeModeAlert = document.getElementById('freeModeAlert');
                if (freeModeAlert) {
                    freeModeAlert.classList.toggle('hidden', !freeModeEnabled);
                }
                
            } catch (err) {
                console.error('Failed to load settings:', err);
                alert('設定の読み込みに失敗しました');
            }
        }
        
        async function saveMyaspSettings() {
            try {
                const settings = [
                    ['free_mode_enabled', document.getElementById('settingFreeModeEnabled').value],
                    ['myasp_form_url', document.getElementById('settingMyaspFormUrl').value],
                    ['myasp_form_script', document.getElementById('settingMyaspFormScript').value],
                    ['subscription_monthly_price', document.getElementById('settingSubscriptionPrice').value],
                    ['subscription_plan_name', document.getElementById('settingSubscriptionPlanName').value],
                ];
                
                for (const [key, value] of settings) {
                    await axios.put('/api/admin/settings/' + key, { value });
                }
                
                alert('MyASP設定を保存しました');
                loadSettings();
            } catch (err) {
                console.error('Failed to save MyASP settings:', err);
                alert('保存に失敗しました: ' + (err.response?.data?.error?.message || err.message));
            }
        }
        
        async function saveCostSettings() {
            try {
                const settings = [
                    ['cost_whisper_per_minute', document.getElementById('settingCostWhisper').value],
                    ['cost_image_generation_per_image', document.getElementById('settingCostImage').value],
                    ['cost_video_generation_per_second', document.getElementById('settingCostVideo').value],
                    ['cost_chat_input_per_1k_tokens', document.getElementById('settingCostChatInput').value],
                    ['cost_chat_output_per_1k_tokens', document.getElementById('settingCostChatOutput').value],
                    ['cost_tts_google_per_1m_chars', document.getElementById('settingCostTtsGoogle').value],
                    ['cost_tts_fish_per_1m_chars', document.getElementById('settingCostTtsFish').value],
                ];
                
                for (const [key, value] of settings) {
                    await axios.put('/api/admin/settings/' + key, { value });
                }
                
                alert('コスト設定を保存しました');
            } catch (err) {
                console.error('Failed to save cost settings:', err);
                alert('保存に失敗しました: ' + (err.response?.data?.error?.message || err.message));
            }
        }
        
        function updateWebhookUrl() {
            const webhookUrl = window.location.origin + '/api/myasp/subscription';
            document.getElementById('webhookUrl').textContent = webhookUrl;
        }
        
        function copyWebhookUrl() {
            const url = document.getElementById('webhookUrl').textContent;
            navigator.clipboard.writeText(url).then(() => {
                alert('Webhook URLをコピーしました');
            });
        }
        
        async function loadWebhookLogs() {
            try {
                const res = await axios.get('/api/admin/webhook-logs?limit=10');
                const logs = res.data.logs || [];
                
                const tbody = document.getElementById('webhookLogsTbody');
                if (logs.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="4" class="p-4 text-center text-gray-500">Webhookログがありません</td></tr>';
                    return;
                }
                
                const statusClass = {
                    'received': 'bg-blue-100 text-blue-800',
                    'processing': 'bg-yellow-100 text-yellow-800',
                    'completed': 'bg-green-100 text-green-800',
                    'failed': 'bg-red-100 text-red-800',
                };
                
                tbody.innerHTML = logs.map(log => \`
                    <tr class="border-b">
                        <td class="p-2 text-xs text-gray-500">\${new Date(log.created_at).toLocaleString('ja-JP')}</td>
                        <td class="p-2 text-xs">\${escapeHtml(log.event_type)}</td>
                        <td class="p-2">
                            <span class="px-2 py-0.5 rounded text-xs \${statusClass[log.processed_status] || 'bg-gray-100'}">
                                \${log.processed_status}
                            </span>
                        </td>
                        <td class="p-2 text-xs text-gray-600">
                            \${log.error_message ? escapeHtml(log.error_message) : '-'}
                        </td>
                    </tr>
                \`).join('');
                
            } catch (err) {
                console.error('Failed to load webhook logs:', err);
                document.getElementById('webhookLogsTbody').innerHTML = 
                    '<tr><td colspan="4" class="p-4 text-center text-red-500">読み込みに失敗しました</td></tr>';
            }
        }
        
        // ============================================
        // Sales Tab Functions
        // ============================================
        let currentSalesMonth = '';
        
        function initSalesMonthSelector() {
            const sel = document.getElementById('salesMonthSelect');
            if (!sel) return;
            sel.innerHTML = '';
            const now = new Date();
            for (let i = 0; i < 12; i++) {
                const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
                const yyyy = d.getFullYear();
                const mm = String(d.getMonth() + 1).padStart(2, '0');
                const opt = document.createElement('option');
                opt.value = yyyy + '-' + mm;
                opt.textContent = yyyy + '年' + mm + '月';
                sel.appendChild(opt);
            }
            currentSalesMonth = sel.value;
        }
        
        async function loadSalesSummary() {
            initSalesMonthSelector();
            
            try {
                const sel = document.getElementById('salesMonthSelect');
                const period = sel?.value || currentSalesMonth || '';
                const [year, month] = period ? period.split('-') : [null, null];
                const qs = (year && month) ? '?year=' + encodeURIComponent(year) + '&month=' + encodeURIComponent(month) : '';
                
                const res = await axios.get('/api/admin/sales/summary' + qs);
                const data = res.data;
                salesLoaded = true;
                
                // Update KPIs
                document.getElementById('salesKpiTotal').textContent = '¥' + (data.summary?.total_amount || 0).toLocaleString();
                document.getElementById('salesKpiCount').textContent = (data.summary?.payment_count || 0).toLocaleString();
                document.getElementById('salesKpiActive').textContent = (data.summary?.active_subscribers || 0).toLocaleString();
                document.getElementById('salesKpiArpu').textContent = '¥' + (data.summary?.arpu || 0).toLocaleString();
                
            } catch (err) {
                console.error('Failed to load sales summary:', err);
                document.getElementById('salesKpiTotal').textContent = 'Error';
            }
        }
        
        async function loadSalesByUser() {
            try {
                const sel = document.getElementById('salesMonthSelect');
                const period = sel?.value || currentSalesMonth || '';
                const [year, month] = period ? period.split('-') : [null, null];
                const qs = (year && month) ? '?year=' + encodeURIComponent(year) + '&month=' + encodeURIComponent(month) : '';
                
                const res = await axios.get('/api/admin/sales/by-user' + qs);
                const users = res.data.users || [];
                
                const tbody = document.getElementById('salesByUserTbody');
                if (users.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-gray-500">売上データがありません</td></tr>';
                    return;
                }
                
                tbody.innerHTML = users.map(u => \`
                    <tr class="border-b hover:bg-gray-50">
                        <td class="p-3">
                            <div class="font-medium">\${escapeHtml(u.name || 'Unknown')}</div>
                            <div class="text-xs text-gray-500">\${escapeHtml(u.email || '')}</div>
                        </td>
                        <td class="p-3 text-right">\${u.payment_count || 0}</td>
                        <td class="p-3 text-right font-medium">¥\${(u.total_amount || 0).toLocaleString()}</td>
                        <td class="p-3 text-center">
                            <span class="px-2 py-1 rounded-full text-xs \${u.subscription_status === 1 ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}">
                                \${SUB_STATUS_LABELS[u.subscription_status]?.label || '不明'}
                            </span>
                        </td>
                        <td class="p-3 text-xs text-gray-500">\${u.last_payment_at ? new Date(u.last_payment_at).toLocaleDateString('ja-JP') : '-'}</td>
                    </tr>
                \`).join('');
                
            } catch (err) {
                console.error('Failed to load sales by user:', err);
                document.getElementById('salesByUserTbody').innerHTML = 
                    '<tr><td colspan="5" class="p-4 text-center text-red-500">読み込みに失敗しました</td></tr>';
            }
        }
        
        async function loadSalesRecords() {
            try {
                const sel = document.getElementById('salesMonthSelect');
                const period = sel?.value || currentSalesMonth || '';
                const [year, month] = period ? period.split('-') : [null, null];
                const qs = (year && month) ? '?year=' + encodeURIComponent(year) + '&month=' + encodeURIComponent(month) + '&limit=20' : '?limit=20';
                
                const res = await axios.get('/api/admin/sales/records' + qs);
                const records = res.data.records || [];
                
                const tbody = document.getElementById('salesRecordsTbody');
                if (records.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-gray-500">決済履歴がありません</td></tr>';
                    return;
                }
                
                const statusLabels = {
                    'success': { label: '成功', class: 'bg-green-100 text-green-800' },
                    'failed': { label: '失敗', class: 'bg-red-100 text-red-800' },
                    'refunded': { label: '返金', class: 'bg-yellow-100 text-yellow-800' },
                    'pending': { label: '処理中', class: 'bg-blue-100 text-blue-800' },
                };
                
                tbody.innerHTML = records.map(r => \`
                    <tr class="border-b hover:bg-gray-50">
                        <td class="p-3 text-xs text-gray-500">\${new Date(r.paid_at).toLocaleString('ja-JP')}</td>
                        <td class="p-3">
                            <div class="text-sm">\${escapeHtml(r.user_name || 'Unknown')}</div>
                            <div class="text-xs text-gray-500">\${escapeHtml(r.user_email || '')}</div>
                        </td>
                        <td class="p-3 text-right font-medium">¥\${(r.amount || 0).toLocaleString()}</td>
                        <td class="p-3">
                            <span class="px-2 py-1 rounded-full text-xs \${statusLabels[r.payment_status]?.class || 'bg-gray-100'}">
                                \${statusLabels[r.payment_status]?.label || r.payment_status}
                            </span>
                        </td>
                        <td class="p-3 text-xs text-gray-500">\${r.myasp_transaction_id || '-'}</td>
                    </tr>
                \`).join('');
                
            } catch (err) {
                console.error('Failed to load sales records:', err);
                document.getElementById('salesRecordsTbody').innerHTML = 
                    '<tr><td colspan="5" class="p-4 text-center text-red-500">読み込みに失敗しました</td></tr>';
            }
        }
        
        function onSalesMonthChange() {
            const sel = document.getElementById('salesMonthSelect');
            currentSalesMonth = sel?.value || '';
            loadSalesSummary();
            loadSalesByUser();
            loadSalesRecords();
        }
        
        async function exportSalesCsv() {
            try {
                const sel = document.getElementById('salesMonthSelect');
                const period = sel?.value || currentSalesMonth || '';
                const [year, month] = period ? period.split('-') : [null, null];
                const qs = (year && month) ? '?year=' + encodeURIComponent(year) + '&month=' + encodeURIComponent(month) : '';
                
                const res = await axios.get('/api/admin/sales/export' + qs);
                const csv = res.data.csv;
                
                // Download as CSV
                const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                const link = document.createElement('a');
                link.href = URL.createObjectURL(blob);
                link.download = 'sales_' + (period || 'all') + '.csv';
                link.click();
                
            } catch (err) {
                console.error('Failed to export sales CSV:', err);
                alert('CSVエクスポートに失敗しました');
            }
        }
        
        // ============================================
        // Audio Library Functions (Phase 2)
        // ============================================
        
        async function loadAudioLibrary() {
            try {
                const typeFilter = document.getElementById('audioLibraryTypeFilter')?.value || '';
                const qs = typeFilter ? '?type=' + typeFilter : '';
                
                const [audioRes, statsRes] = await Promise.all([
                    axios.get('/api/admin/audio-library' + qs + (qs ? '&active=false' : '?active=false')),
                    axios.get('/api/admin/audio-library/stats')
                ]);
                
                const audioList = audioRes.data.audio_library || [];
                const stats = statsRes.data;
                audioLibraryLoaded = true;
                
                // Update stats
                const bgmStat = (stats.by_type || []).find(s => s.audio_type === 'bgm') || { total: 0, active: 0 };
                const sfxStat = (stats.by_type || []).find(s => s.audio_type === 'sfx') || { total: 0, active: 0 };
                const totalActive = (stats.by_type || []).reduce((sum, s) => sum + (s.active || 0), 0);
                const total = (stats.by_type || []).reduce((sum, s) => sum + (s.total || 0), 0);
                
                document.getElementById('audioStatTotal').textContent = total;
                document.getElementById('audioStatBgm').textContent = bgmStat.total || 0;
                document.getElementById('audioStatSfx').textContent = sfxStat.total || 0;
                document.getElementById('audioStatActive').textContent = totalActive;
                
                // Render list
                const listEl = document.getElementById('audioLibraryList');
                if (audioList.length === 0) {
                    listEl.innerHTML = '<div class="p-6 text-gray-500 text-center">登録された音声がありません</div>';
                    return;
                }
                
                const moodLabels = {
                    'bright': '明るい',
                    'calm': '落ち着いた',
                    'dramatic': 'ドラマチック',
                    'mysterious': 'ミステリー',
                    'sad': '悲しい',
                    'exciting': '盛り上がる',
                    'relaxing': 'リラックス'
                };
                
                listEl.innerHTML = audioList.map(a => \`
                    <div class="p-4 flex items-center justify-between hover:bg-gray-50 \${a.is_active ? '' : 'opacity-50 bg-gray-100'}">
                        <div class="flex items-center gap-4">
                            <div class="w-12 h-12 rounded-lg flex items-center justify-center \${a.audio_type === 'bgm' ? 'bg-purple-100' : 'bg-blue-100'}">
                                <i class="fas \${a.audio_type === 'bgm' ? 'fa-music text-purple-600' : 'fa-volume-up text-blue-600'} text-xl"></i>
                            </div>
                            <div>
                                <div class="font-semibold text-gray-800">
                                    \${escapeHtml(a.name)}
                                    \${!a.is_active ? '<span class="ml-2 text-xs text-red-500">(無効)</span>' : ''}
                                </div>
                                <div class="text-sm text-gray-500">\${escapeHtml(a.description || '')}</div>
                                <div class="flex items-center gap-2 mt-1">
                                    <span class="px-2 py-0.5 rounded text-xs \${a.audio_type === 'bgm' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}">
                                        \${a.audio_type.toUpperCase()}
                                    </span>
                                    \${a.mood ? '<span class="px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-700">' + (moodLabels[a.mood] || a.mood) + '</span>' : ''}
                                    \${a.category ? '<span class="px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-700">' + escapeHtml(a.category) + '</span>' : ''}
                                    \${a.duration_ms ? '<span class="text-xs text-gray-500">' + Math.round(a.duration_ms / 1000) + '秒</span>' : ''}
                                </div>
                            </div>
                        </div>
                        <div class="flex items-center gap-2">
                            \${a.file_url ? '<a href="' + escapeHtml(a.file_url) + '" target="_blank" class="px-3 py-1 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 text-sm"><i class="fas fa-play mr-1"></i>試聴</a>' : ''}
                            <button onclick="editAudio(\${a.id})" class="px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm">
                                <i class="fas fa-edit mr-1"></i>編集
                            </button>
                            \${a.is_active 
                                ? '<button onclick="deactivateAudio(' + a.id + ', \\x27' + escapeHtml(a.name) + '\\x27)" class="px-3 py-1 bg-red-600 text-white rounded hover:bg-red-700 text-sm"><i class="fas fa-trash mr-1"></i>無効化</button>'
                                : '<button onclick="restoreAudio(' + a.id + ')" class="px-3 py-1 bg-green-600 text-white rounded hover:bg-green-700 text-sm"><i class="fas fa-undo mr-1"></i>復元</button>'
                            }
                        </div>
                    </div>
                \`).join('');
                
            } catch (err) {
                console.error('Failed to load audio library:', err);
                document.getElementById('audioLibraryList').innerHTML = 
                    '<div class="p-6 text-red-500 text-center">読み込みに失敗しました</div>';
            }
        }
        
        function openAddAudioModal() {
            document.getElementById('editAudioId').value = '';
            document.getElementById('addAudioModalTitle').innerHTML = '<i class="fas fa-music mr-2 text-purple-600"></i>音声を追加';
            document.getElementById('audioType').value = 'bgm';
            document.getElementById('audioName').value = '';
            document.getElementById('audioDescription').value = '';
            document.getElementById('audioCategory').value = '';
            document.getElementById('audioMood').value = '';
            document.getElementById('audioTags').value = '';
            document.getElementById('audioFileUrl').value = '';
            document.getElementById('audioFileSize').value = '';
            document.getElementById('audioDuration').value = '';
            document.getElementById('audioSource').value = 'suno_ai';
            document.getElementById('audioSortOrder').value = '0';
            document.getElementById('addAudioModal').classList.remove('hidden');
        }
        
        function closeAddAudioModal() {
            document.getElementById('addAudioModal').classList.add('hidden');
        }
        
        async function editAudio(id) {
            try {
                const res = await axios.get('/api/admin/audio-library/' + id);
                const a = res.data.audio;
                
                document.getElementById('editAudioId').value = a.id;
                document.getElementById('addAudioModalTitle').innerHTML = '<i class="fas fa-edit mr-2 text-blue-600"></i>音声を編集';
                document.getElementById('audioType').value = a.audio_type || 'bgm';
                document.getElementById('audioName').value = a.name || '';
                document.getElementById('audioDescription').value = a.description || '';
                document.getElementById('audioCategory').value = a.category || '';
                document.getElementById('audioMood').value = a.mood || '';
                document.getElementById('audioTags').value = a.tags || '';
                document.getElementById('audioFileUrl').value = a.file_url || '';
                document.getElementById('audioFileSize').value = a.file_size || '';
                document.getElementById('audioDuration').value = a.duration_ms || '';
                document.getElementById('audioSource').value = a.source || 'manual';
                document.getElementById('audioSortOrder').value = a.sort_order || 0;
                document.getElementById('addAudioModal').classList.remove('hidden');
                
            } catch (err) {
                console.error('Failed to load audio:', err);
                alert('音声データの読み込みに失敗しました');
            }
        }
        
        async function saveAudio() {
            const editId = document.getElementById('editAudioId').value;
            const data = {
                audio_type: document.getElementById('audioType').value,
                name: document.getElementById('audioName').value.trim(),
                description: document.getElementById('audioDescription').value.trim(),
                category: document.getElementById('audioCategory').value.trim(),
                mood: document.getElementById('audioMood').value,
                tags: document.getElementById('audioTags').value.trim(),
                file_url: document.getElementById('audioFileUrl').value.trim(),
                file_size: parseInt(document.getElementById('audioFileSize').value) || null,
                duration_ms: parseInt(document.getElementById('audioDuration').value) || null,
                source: document.getElementById('audioSource').value,
                sort_order: parseInt(document.getElementById('audioSortOrder').value) || 0
            };
            
            if (!data.name) {
                alert('名前を入力してください');
                return;
            }
            if (!data.file_url) {
                alert('ファイルURLを入力してください');
                return;
            }
            
            try {
                if (editId) {
                    await axios.put('/api/admin/audio-library/' + editId, data);
                    alert('音声を更新しました');
                } else {
                    await axios.post('/api/admin/audio-library', data);
                    alert('音声を追加しました');
                }
                closeAddAudioModal();
                loadAudioLibrary();
            } catch (err) {
                console.error('Failed to save audio:', err);
                alert('保存に失敗しました: ' + (err.response?.data?.error || err.message));
            }
        }
        
        async function handleAudioUpload(input) {
            const file = input.files[0];
            if (!file) return;
            
            const progressEl = document.getElementById('audioUploadProgress');
            progressEl.classList.remove('hidden');
            
            try {
                const formData = new FormData();
                formData.append('file', file);
                formData.append('audio_type', document.getElementById('audioType').value);
                
                const res = await axios.post('/api/admin/audio-library/upload', formData, {
                    headers: { 'Content-Type': 'multipart/form-data' }
                });
                
                document.getElementById('audioFileUrl').value = res.data.file_url;
                document.getElementById('audioFileSize').value = res.data.file_size || '';
                progressEl.classList.add('hidden');
                alert('アップロード完了！');
                
            } catch (err) {
                console.error('Failed to upload audio:', err);
                progressEl.classList.add('hidden');
                alert('アップロードに失敗しました: ' + (err.response?.data?.error || err.message));
            }
            
            input.value = '';
        }
        
        async function deactivateAudio(id, name) {
            if (!confirm('「' + name + '」を無効化しますか？')) return;
            
            try {
                await axios.delete('/api/admin/audio-library/' + id);
                alert('無効化しました');
                loadAudioLibrary();
            } catch (err) {
                console.error('Failed to deactivate audio:', err);
                alert('無効化に失敗しました');
            }
        }
        
        async function restoreAudio(id) {
            try {
                await axios.post('/api/admin/audio-library/' + id + '/restore');
                alert('復元しました');
                loadAudioLibrary();
            } catch (err) {
                console.error('Failed to restore audio:', err);
                alert('復元に失敗しました');
            }
        }
        
        // Initialize
        init();
    </script>
</body>
</html>
  `;
