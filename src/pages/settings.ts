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
        
        <!-- Email Change Section -->
        <div class="bg-white rounded-xl shadow-md p-6 mb-6">
            <h2 class="text-lg font-bold text-gray-800 mb-4">
                <i class="fas fa-envelope mr-2 text-orange-600"></i>
                メールアドレス変更
            </h2>
            <form id="emailForm" class="space-y-4">
                <div>
                    <label class="block text-sm font-semibold text-gray-700 mb-2">現在のメールアドレス</label>
                    <input type="email" id="currentEmail" disabled
                        class="w-full px-4 py-3 border border-gray-200 rounded-lg bg-gray-100 text-gray-600" />
                </div>
                <div>
                    <label class="block text-sm font-semibold text-gray-700 mb-2">新しいメールアドレス</label>
                    <input type="email" id="newEmail" required
                        class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500" />
                </div>
                <div>
                    <label class="block text-sm font-semibold text-gray-700 mb-2">パスワード（確認用）</label>
                    <input type="password" id="emailChangePassword" required
                        class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500" />
                    <p class="text-xs text-gray-500 mt-1">セキュリティのため、現在のパスワードを入力してください</p>
                </div>
                <div id="emailMessage" class="hidden text-sm p-3 rounded-lg"></div>
                <button type="submit"
                    class="w-full py-3 bg-orange-600 text-white rounded-lg hover:bg-orange-700 transition-colors font-semibold">
                    <i class="fas fa-at mr-2"></i>メールアドレスを変更
                </button>
            </form>
        </div>
        
        <!-- Video API Key Section (Phase D-1 + Gate2) -->
        <div class="bg-white rounded-xl shadow-md p-6 mb-6">
            <h2 class="text-lg font-bold text-gray-800 mb-4">
                <i class="fas fa-video mr-2 text-purple-600"></i>
                動画生成 API キー設定
            </h2>
            <div class="text-sm text-gray-600 mb-4 space-y-3">
                <div class="bg-blue-50 border border-blue-200 rounded-lg p-3">
                    <p class="font-semibold text-blue-800 mb-2">📌 Veo2 と Veo3 の違い</p>
                    <ul class="text-xs text-blue-700 space-y-1 ml-4 list-disc">
                        <li><strong>Veo2</strong>: Google AI Studio のAPIキー（GCP課金設定必須）</li>
                        <li><strong>Veo3</strong>: Vertex AI のAPIキー（高品質、GCP プロジェクト必要）</li>
                    </ul>
                </div>
                
                <!-- GCP Billing Setup Guide -->
                <div class="bg-amber-50 border border-amber-300 rounded-lg p-4">
                    <p class="font-semibold text-amber-800 mb-2">
                        <i class="fas fa-exclamation-triangle mr-1"></i>
                        ⚠️ 重要: GCP課金の有効化が必要です
                    </p>
                    <p class="text-xs text-amber-700 mb-3">
                        Veo2/Veo3 で動画を生成するには、Google Cloud Platform（GCP）の課金を有効にする必要があります。
                        APIキーを取得しただけでは動画生成できません。
                    </p>
                    <div class="bg-white border border-amber-200 rounded-lg p-3 mb-3">
                        <p class="font-semibold text-gray-800 text-xs mb-2">📋 設定手順:</p>
                        <ol class="text-xs text-gray-700 space-y-2 ml-4 list-decimal">
                            <li>
                                <a href="https://console.cloud.google.com/" target="_blank" class="text-blue-600 hover:underline font-medium">
                                    Google Cloud Console
                                    <i class="fas fa-external-link-alt ml-1 text-[10px]"></i>
                                </a>
                                にアクセス
                            </li>
                            <li>左メニューから「<strong>お支払い</strong>」を選択</li>
                            <li>「<strong>課金アカウントをリンク</strong>」をクリック</li>
                            <li>クレジットカード情報を登録（無料枠内なら課金されません）</li>
                            <li>
                                <a href="https://console.cloud.google.com/apis/library/aiplatform.googleapis.com" target="_blank" class="text-blue-600 hover:underline font-medium">
                                    Vertex AI API
                                    <i class="fas fa-external-link-alt ml-1 text-[10px]"></i>
                                </a>
                                を有効化
                            </li>
                        </ol>
                    </div>
                    <p class="text-[10px] text-amber-600">
                        💡 ヒント: 課金を有効にしても、無料枠（毎月$300相当のクレジット）の範囲内であれば請求は発生しません。
                    </p>
                </div>
                
                <p class="text-xs text-gray-500">
                    ※ 使用する動画生成エンジンに応じて、対応するAPIキーを設定してください。
                </p>
            </div>
            
            <!-- Key Migration Notice (P1: 移行案内) -->
            <div id="migrationNotice" class="hidden bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4">
                <div class="flex items-start">
                    <i class="fas fa-exclamation-triangle text-amber-500 mt-0.5 mr-3"></i>
                    <div class="flex-1">
                        <p class="font-semibold text-amber-800">暗号鍵の更新について</p>
                        <p class="text-sm text-amber-700 mt-1">
                            過去に保存したAPIキーが移行対象になっている場合があります。
                            「テスト」ボタンを押すと、必要に応じて自動的に新しい鍵へ移行されます（数秒で完了）。
                        </p>
                    </div>
                </div>
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
                
                // Fill email change form
                document.getElementById('currentEmail').value = currentUser.email;
                
                // Fill account info
                document.getElementById('infoEmail').textContent = currentUser.email;
                document.getElementById('infoRole').textContent = 
                    currentUser.role === 'superadmin' ? 'スーパー管理者' : '管理者';
                document.getElementById('infoCreatedAt').textContent = 
                    new Date(currentUser.created_at).toLocaleDateString('ja-JP');
                
                // Check sponsor status and update UI accordingly
                if (currentUser.api_sponsor_id) {
                    // User is sponsored - show sponsor notice instead of API key inputs
                    showSponsoredUserNotice();
                } else {
                    // User is not sponsored - load API keys as normal
                    loadApiKeys();
                }
                
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
        
        // Email change form
        document.getElementById('emailForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const newEmail = document.getElementById('newEmail').value.trim();
            const password = document.getElementById('emailChangePassword').value;
            
            if (!newEmail) {
                showMessage('emailMessage', '新しいメールアドレスを入力してください', true);
                return;
            }
            
            // Basic email validation
            const emailRegex = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
            if (!emailRegex.test(newEmail)) {
                showMessage('emailMessage', '有効なメールアドレスを入力してください', true);
                return;
            }
            
            if (newEmail.toLowerCase() === currentUser.email.toLowerCase()) {
                showMessage('emailMessage', '現在のメールアドレスと同じです', true);
                return;
            }
            
            try {
                const res = await axios.put('/api/auth/me', {
                    new_email: newEmail,
                    email_change_password: password
                });
                showMessage('emailMessage', 'メールアドレスを変更しました');
                document.getElementById('emailForm').reset();
                // Update displayed email
                currentUser.email = res.data.new_email || newEmail;
                document.getElementById('currentEmail').value = currentUser.email;
                document.getElementById('infoEmail').textContent = currentUser.email;
            } catch (err) {
                showMessage('emailMessage', err.response?.data?.error?.message || 'メールアドレス変更に失敗しました', true);
            }
        });
        
        // ======================
        // Video API Key Management (Phase D-1 + P1 Key Migration + Gate2 Veo3)
        // ======================
        
        // 仕様: provider は 'google'（Veo2）と 'vertex'（Veo3）
        // google: Google AI Studio (https://aistudio.google.com/) のAPIキー
        // vertex: Vertex AI Studio (https://console.cloud.google.com/vertex-ai/studio/settings/api-keys) のAPIキー
        const PROVIDERS = [
            { 
                provider: 'google', 
                name: '🎬 Veo2 (Google AI Studio)', 
                description: 'Google AI Studio のAPIキーで動画生成',
                placeholder: 'AIzaSy...',
                helpUrl: 'https://aistudio.google.com/',
                helpText: 'AI Studio でAPIキーを作成'
            },
            { 
                provider: 'vertex', 
                name: '🚀 Veo3 (Vertex AI)', 
                description: 'Vertex AI のAPIキーで高品質動画生成',
                placeholder: 'AQ.Ab8RN...',
                helpUrl: 'https://console.cloud.google.com/vertex-ai/studio/settings/api-keys',
                helpText: 'Vertex AI Studio > 設定 > APIキー で取得'
            }
        ];
        
        // P1: 状態に応じたメッセージとスタイル
        function getStatusInfo(key) {
            if (!key) {
                return { text: '未設定', icon: 'times-circle', color: 'text-gray-400', badge: '' };
            }
            
            const status = key.decryption_status || 'unknown';
            const needsMigration = key.needs_migration || false;
            
            if (status === 'invalid') {
                return {
                    text: '復号失敗',
                    icon: 'exclamation-circle',
                    color: 'text-red-600',
                    badge: 'bg-red-100 text-red-700 border-red-200',
                    message: '復号に失敗しました。キーの形式が変わった可能性があります。再入力が必要です。'
                };
            }
            
            if (status === 'valid' && needsMigration) {
                return {
                    text: '移行が必要',
                    icon: 'exclamation-triangle',
                    color: 'text-amber-600',
                    badge: 'bg-amber-100 text-amber-700 border-amber-200',
                    message: '旧鍵で復号されました。「テスト」を押して自動移行してください。'
                };
            }
            
            if (status === 'valid') {
                return {
                    text: '正常',
                    icon: 'check-circle',
                    color: 'text-green-600',
                    badge: 'bg-green-100 text-green-700 border-green-200',
                    message: null
                };
            }
            
            return {
                text: '設定済み',
                icon: 'check-circle',
                color: 'text-green-600',
                badge: '',
                message: null
            };
        }
        
        async function loadApiKeys() {
            try {
                const res = await axios.get('/api/user/api-keys');
                const configuredKeys = res.data.keys || [];
                
                // P1: 移行が必要なキーがあるか確認
                const hasMigrationNeeded = configuredKeys.some(k => k.needs_migration);
                const hasInvalid = configuredKeys.some(k => k.decryption_status === 'invalid');
                const migrationNotice = document.getElementById('migrationNotice');
                
                if (hasMigrationNeeded || hasInvalid) {
                    migrationNotice.classList.remove('hidden');
                } else {
                    migrationNotice.classList.add('hidden');
                }
                
                const section = document.getElementById('apiKeysSection');
                section.innerHTML = PROVIDERS.map(p => {
                    const configured = configuredKeys.find(k => k.provider === p.provider);
                    const isConfigured = !!configured && configured.decryption_status !== 'invalid';
                    const statusInfo = getStatusInfo(configured);
                    
                    return \`
                    <div class="border rounded-lg p-4 mb-4 \${statusInfo.badge ? 'border-2 ' + statusInfo.badge.split(' ')[2] : ''}" id="api-key-\${p.provider}">
                        <div class="flex items-center justify-between mb-2">
                            <div>
                                <h3 class="font-semibold text-gray-800">\${p.name}</h3>
                                <p class="text-xs text-gray-500">\${p.description}</p>
                                <a href="\${p.helpUrl}" target="_blank" class="text-xs text-blue-600 hover:underline">
                                    <i class="fas fa-external-link-alt mr-1"></i>\${p.helpText}
                                </a>
                            </div>
                            <span class="\${statusInfo.color} text-sm font-medium">
                                <i class="fas fa-\${statusInfo.icon} mr-1"></i>
                                \${statusInfo.text}
                            </span>
                        </div>
                        
                        \${statusInfo.message ? \`
                        <div class="mb-3 p-2 rounded-lg text-sm \${statusInfo.badge}">
                            <i class="fas fa-info-circle mr-1"></i>
                            \${statusInfo.message}
                        </div>
                        \` : ''}
                        
                        <div class="flex gap-2 flex-wrap">
                            <input 
                                type="password" 
                                id="apiKey-\${p.provider}"
                                placeholder="\${isConfigured ? '新しいキーで上書き...' : p.placeholder}"
                                class="flex-1 min-w-[200px] px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                            />
                            <button 
                                onclick="saveApiKey('\${p.provider}')"
                                class="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-sm font-semibold"
                            >
                                <i class="fas fa-save mr-1"></i>保存
                            </button>
                            \${configured ? \`
                                <button 
                                    onclick="testApiKey('\${p.provider}')"
                                    class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-semibold"
                                    id="testBtn-\${p.provider}"
                                >
                                    <i class="fas fa-flask mr-1"></i>テスト
                                </button>
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
        
        // P1: テストボタン - 自動移行を実行
        async function testApiKey(provider) {
            const btn = document.getElementById(\`testBtn-\${provider}\`);
            const originalHtml = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>テスト中...';
            
            try {
                const res = await axios.get(\`/api/settings/api-keys/\${provider}/test\`);
                const data = res.data;
                
                let message = '';
                let isSuccess = true;
                
                if (data.migrated) {
                    // 自動移行が成功
                    message = '✅ 自動移行しました（旧鍵 → 新鍵）。キープレビュー: ' + data.key_preview;
                } else if (data.was_legacy_key) {
                    // 旧鍵で復号できたが移行は他で完了済み
                    message = '✅ 復号できました（移行は完了済みの可能性があります）。キープレビュー: ' + data.key_preview;
                } else {
                    // 現行鍵で復号成功
                    message = '✅ 正常に復号できました。キープレビュー: ' + data.key_preview + ' (' + data.key_length + '文字)';
                }
                
                showApiKeyMessage(provider, message, false);
                
                // 状態をリフレッシュ
                setTimeout(loadApiKeys, 1000);
                
            } catch (err) {
                const errorData = err.response?.data?.error;
                let message = '復号に失敗しました';
                
                if (errorData) {
                    message = errorData.message || message;
                    if (errorData.hint) {
                        message += '\\n' + errorData.hint;
                    }
                }
                
                showApiKeyMessage(provider, message, true);
            } finally {
                btn.disabled = false;
                btn.innerHTML = originalHtml;
            }
        }
        
        function showApiKeyMessage(provider, message, isError = false) {
            const el = document.getElementById(\`apiKeyMessage-\${provider}\`);
            if (!el) return;
            el.innerHTML = message.replace(/\\n/g, '<br>');
            el.className = 'text-sm p-2 rounded mt-2 ' + (isError ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-600');
            el.classList.remove('hidden');
            setTimeout(() => el.classList.add('hidden'), 8000);
        }
        
        // Show notice for sponsored users (they don't need to configure API keys)
        function showSponsoredUserNotice() {
            const section = document.getElementById('apiKeysSection');
            section.innerHTML = \`
                <div class="bg-gradient-to-r from-green-50 to-emerald-50 border-2 border-green-300 rounded-xl p-6">
                    <div class="flex items-start gap-4">
                        <div class="flex-shrink-0">
                            <div class="w-12 h-12 bg-green-500 rounded-full flex items-center justify-center">
                                <i class="fas fa-gift text-white text-xl"></i>
                            </div>
                        </div>
                        <div>
                            <h3 class="text-lg font-bold text-green-800 mb-2">
                                <i class="fas fa-star text-yellow-500 mr-2"></i>
                                スポンサー対象アカウント
                            </h3>
                            <p class="text-green-700 mb-3">
                                このアカウントは<strong>スポンサー対象</strong>に設定されています。
                                APIキーを自分で設定する必要はありません。
                            </p>
                            <div class="bg-white/60 rounded-lg p-4 text-sm text-green-800">
                                <p class="font-semibold mb-2">利用可能な機能：</p>
                                <ul class="space-y-1">
                                    <li><i class="fas fa-check text-green-600 mr-2"></i>画像生成（Gemini Imagen）</li>
                                    <li><i class="fas fa-check text-green-600 mr-2"></i>動画生成（Veo2）</li>
                                    <li><i class="fas fa-check text-green-600 mr-2"></i>音声生成（ElevenLabs / Google TTS）</li>
                                    <li><i class="fas fa-check text-green-600 mr-2"></i>Video Build（動画合成）</li>
                                </ul>
                            </div>
                            <p class="text-xs text-green-600 mt-3">
                                <i class="fas fa-info-circle mr-1"></i>
                                スポンサー設定についてのご質問は管理者にお問い合わせください。
                            </p>
                        </div>
                    </div>
                </div>
            \`;
            
            // Hide migration notice for sponsored users
            const migrationNotice = document.getElementById('migrationNotice');
            if (migrationNotice) {
                migrationNotice.classList.add('hidden');
            }
        }
        
        init();
    </script>
</body>
</html>
  `;
