const fs = require('fs');
const envContent = fs.readFileSync('.env', 'utf8');
envContent.split('\n').forEach(line => {
  const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
  if (match) {
    const key = match[1];
    let value = match[2] || '';
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (key === 'OPENAI_API_KEY') {
      console.log('Value length:', value.length);
      console.log('Hex representation:', Buffer.from(value).toString('hex'));
      console.log('String representation:', JSON.stringify(value));
    }
  }
});
