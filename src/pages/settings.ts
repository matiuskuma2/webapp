export const settingsHtml = `

<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>設定 - RILARC Scenario Generator</title>
    <link rel="icon" type="image/svg+xml" href="/static/favicon.svg">
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
</head>
<body class="bg-gray-100 min-h-screen">
    <!-- Header -->
    <header class="bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-lg">
        <div class="container mx-auto px-4 py-4 flex items-center justify-between">
            <h1 class="text-xl font-bold">
                <i class="fas fa-cog mr-2"></i>
                設定
            </h1>
            <a href="/" class="text-white hover:text-gray-200">
                <i class="fas fa-home mr-1"></i>ホーム
            </a>
        </div>
    </header>
    
    <!-- Auth Loading -->
    <div id="authLoading" class="flex items-center justify-center py-12">
        <i class="fas fa-spinner fa-spin text-4xl text-blue-600"></i>
    </div>
    
    <!-- Main Content -->
    <main id="mainContent" class="hidden container mx-auto px-4 py-8 max-w-2xl">
        <!-- Profile Section -->
        <div class="bg-white rounded-xl shadow-md p-6 mb-6">
            <h2 class="text-lg font-bold text-gray-800 mb-4">
                <i class="fas fa-user mr-2 text-blue-600"></i>
                プロフィール
            </h2>
            <form id="profileForm" class="space-y-4">
                <div>
                    <label class="block text-sm font-semibold text-gray-700 mb-2">名前</label>
                    <input type="text" id="profileName" required
                        class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                    <label class="block text-sm font-semibold text-gray-700 mb-2">会社名（任意）</label>
                    <input type="text" id="profileCompany"
                        class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                    <label class="block text-sm font-semibold text-gray-700 mb-2">電話番号（任意）</label>
                    <input type="tel" id="profilePhone"
                        class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div id="profileMessage" class="hidden text-sm p-3 rounded-lg"></div>
                <button type="submit"
                    class="w-full py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-semibold">
                    <i class="fas fa-save mr-2"></i>プロフィールを保存
                </button>
            </form>
        </div>
        
        <!-- Password Section -->
        <div class="bg-white rounded-xl shadow-md p-6 mb-6">
            <h2 class="text-lg font-bold text-gray-800 mb-4">
                <i class="fas fa-lock mr-2 text-green-600"></i>
                パスワード変更
            </h2>
            <form id="passwordForm" class="space-y-4">
                <div>
                    <label class="block text-sm font-semibold text-gray-700 mb-2">現在のパスワード</label>
                    <input type="password" id="currentPassword" required
                        class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500" />
                </div>
                <div>
                    <label class="block text-sm font-semibold text-gray-700 mb-2">新しいパスワード</label>
                    <input type="password" id="newPassword" required minlength="8"
                        class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500" />
                    <p class="text-xs text-gray-500 mt-1">8文字以上で入力してください</p>
                </div>
                <div>
                    <label class="block text-sm font-semibold text-gray-700 mb-2">新しいパスワード（確認）</label>
                    <input type="password" id="confirmPassword" required
                        class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500" />
                </div>
                <div id="passwordMessage" class="hidden text-sm p-3 rounded-lg"></div>
                <button type="submit"
                    class="w-full py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-semibold">
                    <i class="fas fa-key mr-2"></i>パスワードを変更
                </button>
            </form>
        </div>
        
        <!-- Video API Key Section (Phase D-1) -->
        <div class="bg-white rounded-xl shadow-md p-6 mb-6">
            <h2 class="text-lg font-bold text-gray-800 mb-4">
                <i class="fas fa-video mr-2 text-purple-600"></i>
                🎬 動画生成（Google Veo）
            </h2>
            <div class="text-sm text-gray-600 mb-4 space-y-2">
                <p>動画生成には <strong>Google AI Studio</strong> で発行した APIキーが必要です。</p>
                <ol class="list-decimal list-inside ml-2 space-y-1">
                    <li><a href="https://aistudio.google.com/" target="_blank" class="text-blue-600 hover:underline">Google AI Studio</a> にアクセス</li>
                    <li>APIキーを作成（無料枠あり）</li>
                    <li>下の欄に貼り付けて保存</li>
                </ol>
                <p class="text-xs text-gray-500 mt-2">
                    ※ Google Cloud Console（GCP）ではありません。AI Studio のキーをご利用ください。
                </p>
            </div>
            <div id="apiKeysSection">
                <!-- Loaded dynamically -->
                <div class="text-center py-4">
                    <i class="fas fa-spinner fa-spin text-gray-400"></i>
                </div>
            </div>
        </div>
        
        <!-- Account Info -->
        <div class="bg-white rounded-xl shadow-md p-6">
            <h2 class="text-lg font-bold text-gray-800 mb-4">
                <i class="fas fa-info-circle mr-2 text-gray-600"></i>
                アカウント情報
            </h2>
            <div class="space-y-3 text-sm">
                <div class="flex justify-between py-2 border-b">
                    <span class="text-gray-500">メールアドレス</span>
                    <span id="infoEmail" class="font-medium">-</span>
                </div>
                <div class="flex justify-between py-2 border-b">
                    <span class="text-gray-500">ロール</span>
                    <span id="infoRole" class="font-medium">-</span>
                </div>
                <div class="flex justify-between py-2">
                    <span class="text-gray-500">登録日</span>
                    <span id="infoCreatedAt" class="font-medium">-</span>
                </div>
            </div>
        </div>
    </main>
    
    <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
    <script>
        let currentUser = null;
        
        async function init() {
            try {
                const res = await axios.get('/api/auth/me');
                if (!res.data.authenticated) {
                    window.location.href = '/login';
                    return;
                }
                
                currentUser = res.data.user;
                
                // Fill profile form
                document.getElementById('profileName').value = currentUser.name || '';
                document.getElementById('profileCompany').value = currentUser.company || '';
                document.getElementById('profilePhone').value = currentUser.phone || '';
                
                // Fill account info
                document.getElementById('infoEmail').textContent = currentUser.email;
                document.getElementById('infoRole').textContent = 
                    currentUser.role === 'superadmin' ? 'スーパー管理者' : '管理者';
                document.getElementById('infoCreatedAt').textContent = 
                    new Date(currentUser.created_at).toLocaleDateString('ja-JP');
                
                // Show content
                document.getElementById('authLoading').classList.add('hidden');
                document.getElementById('mainContent').classList.remove('hidden');
            } catch (err) {
                window.location.href = '/login';
            }
        }
        
        function showMessage(elementId, message, isError = false) {
            const el = document.getElementById(elementId);
            el.textContent = message;
            el.className = 'text-sm p-3 rounded-lg ' + (isError ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-600');
            el.classList.remove('hidden');
            setTimeout(() => el.classList.add('hidden'), 5000);
        }
        
        // Profile form
        document.getElementById('profileForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            try {
                const res = await axios.put('/api/auth/me', {
                    name: document.getElementById('profileName').value,
                    company: document.getElementById('profileCompany').value || null,
                    phone: document.getElementById('profilePhone').value || null
                });
                showMessage('profileMessage', 'プロフィールを更新しました');
            } catch (err) {
                showMessage('profileMessage', err.response?.data?.error?.message || '更新に失敗しました', true);
            }
        });
        
        // Password form
        document.getElementById('passwordForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const currentPassword = document.getElementById('currentPassword').value;
            const newPassword = document.getElementById('newPassword').value;
            const confirmPassword = document.getElementById('confirmPassword').value;
            
            if (newPassword !== confirmPassword) {
                showMessage('passwordMessage', '新しいパスワードが一致しません', true);
                return;
            }
            
            if (newPassword.length < 8) {
                showMessage('passwordMessage', 'パスワードは8文字以上で入力してください', true);
                return;
            }
            
            try {
                await axios.put('/api/auth/me', {
                    current_password: currentPassword,
                    new_password: newPassword
                });
                showMessage('passwordMessage', 'パスワードを変更しました');
                document.getElementById('passwordForm').reset();
            } catch (err) {
                showMessage('passwordMessage', err.response?.data?.error?.message || 'パスワード変更に失敗しました', true);
            }
        });
        
        // ======================
        // Video API Key Management (Phase D-1)
        // ======================
        
        // 仕様: provider は 'google' のみ
        // 取得元: Google AI Studio (https://aistudio.google.com/)
        // ※ Google Cloud Console (GCP) ではない
        const PROVIDERS = [
            { provider: 'google', name: 'Google (Veo)', description: 'Google AI Studio のAPIキーで動画生成' }
        ];
        
        async function loadApiKeys() {
            try {
                const res = await axios.get('/api/user/api-keys');
                const configuredKeys = res.data.keys || [];
                
                const section = document.getElementById('apiKeysSection');
                section.innerHTML = PROVIDERS.map(p => {
                    const configured = configuredKeys.find(k => k.provider === p.provider);
                    const isConfigured = !!configured;
                    return \`
                    <div class="border rounded-lg p-4 mb-3" id="api-key-\${p.provider}">
                        <div class="flex items-center justify-between mb-2">
                            <div>
                                <h3 class="font-semibold text-gray-800">\${p.name}</h3>
                                <p class="text-xs text-gray-500">\${p.description}</p>
                            </div>
                            <span class="\${isConfigured ? 'text-green-600' : 'text-gray-400'} text-sm">
                                <i class="fas fa-\${isConfigured ? 'check-circle' : 'times-circle'} mr-1"></i>
                                \${isConfigured ? '設定済み' : '未設定'}
                            </span>
                        </div>
                        <div class="flex gap-2">
                            <input 
                                type="password" 
                                id="apiKey-\${p.provider}"
                                placeholder="\${isConfigured ? '新しいキーで上書き...' : 'APIキーを入力...'}"
                                class="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                            />
                            <button 
                                onclick="saveApiKey('\${p.provider}')"
                                class="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-sm font-semibold"
                            >
                                <i class="fas fa-save mr-1"></i>保存
                            </button>
                            \${isConfigured ? \`
                                <button 
                                    onclick="deleteApiKey('\${p.provider}')"
                                    class="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm font-semibold"
                                >
                                    <i class="fas fa-trash mr-1"></i>削除
                                </button>
                            \` : ''}
                        </div>
                        <div id="apiKeyMessage-\${p.provider}" class="hidden text-sm p-2 rounded mt-2"></div>
                    </div>
                \`}).join('');
            } catch (err) {
                document.getElementById('apiKeysSection').innerHTML = 
                    '<p class="text-red-600 text-sm">APIキー情報の読み込みに失敗しました</p>';
            }
        }
        
        async function saveApiKey(provider) {
            const input = document.getElementById(\`apiKey-\${provider}\`);
            const apiKey = input.value.trim();
            
            if (!apiKey) {
                showApiKeyMessage(provider, 'APIキーを入力してください', true);
                return;
            }
            
            try {
                await axios.put(\`/api/user/api-keys/\${provider}\`, { api_key: apiKey });
                showApiKeyMessage(provider, 'APIキーを保存しました');
                input.value = '';
                loadApiKeys(); // Refresh status
            } catch (err) {
                showApiKeyMessage(provider, err.response?.data?.error?.message || '保存に失敗しました', true);
            }
        }
        
        async function deleteApiKey(provider) {
            if (!confirm('このAPIキーを削除しますか？動画生成機能が使えなくなります。')) {
                return;
            }
            
            try {
                await axios.delete(\`/api/user/api-keys/\${provider}\`);
                showApiKeyMessage(provider, 'APIキーを削除しました');
                loadApiKeys(); // Refresh status
            } catch (err) {
                showApiKeyMessage(provider, err.response?.data?.error?.message || '削除に失敗しました', true);
            }
        }
        
        function showApiKeyMessage(provider, message, isError = false) {
            const el = document.getElementById(\`apiKeyMessage-\${provider}\`);
            if (!el) return;
            el.textContent = message;
            el.className = 'text-sm p-2 rounded mt-2 ' + (isError ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-600');
            el.classList.remove('hidden');
            setTimeout(() => el.classList.add('hidden'), 5000);
        }
        
        // Load API keys on page load
        setTimeout(loadApiKeys, 500); // After init()
        
        init();
    </script>
</body>
</html>
  `;
