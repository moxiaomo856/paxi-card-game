const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const scripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/g);
scripts.forEach((s, i) => {
  const code = s.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
  if (code.trim().length < 50) return;
  try {
    // 直接在 vm 里 eval（带作用域）
    const vm = require('vm');
    const sandbox = { console, window: {}, document: {}, navigator: {}, setTimeout, clearTimeout };
    vm.runInNewContext(code, sandbox, { filename: 'script[' + i + '].js' });
    console.log('Script[' + i + ']: OK');
  } catch(e) {
    console.log('Script[' + i + ']: FAIL');
    console.log('  ' + e.message);
    if (e.stack) console.log('  stack top: ' + e.stack.split('\n')[1]);
  }
});
