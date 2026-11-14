import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: '.',
  modules: ['@wxt-dev/module-react'],
  hooks: {
    'build:manifestGenerated': (_wxt, manifest) => {
      // 内容脚本按需执行，只使用用户授予的可选站点权限。
      delete manifest.host_permissions;
    },
  },
  manifest: {
    name: '伴读小宠物',
    description: '只围绕你选中的原文解释和提炼，安静地陪你读网页。',
    version: '0.1.0',
    permissions: ['activeTab', 'scripting', 'storage', 'tabs'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    web_accessible_resources: [
      { resources: ['pets/*'], matches: ['https://*/*', 'http://*/*'] },
    ],
    action: {
      default_title: '在当前网站启用伴读小宠物',
      default_popup: 'popup.html',
    },
    options_ui: {
      page: 'options.html',
      open_in_tab: true,
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
  },
});
