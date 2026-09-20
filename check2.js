const fs=require('fs');
const h=fs.readFileSync('index.html','utf8');
const real=fs.readFileSync('index_real.html','utf8');
const rm=real.match(/<script[^>]*>([\s\S]*?)<\/script>/g)[3];
const ic=h.match(/<script[^>]*>([\s\S]*?)<\/script>/g)[1].replace(/^<script[^>]*>/,'').replace(/<\/script>$/,'');
const rc=rm.replace(/^<script[^>]*>/,'').replace(/<\/script>$/,'');
const extra = ic.slice(rc.length);
const lines = extra.split('\n');
console.log('extra lines total:', lines.length);
console.log('--- first 15 lines ---');
for(let i=0;i<15;i++) console.log('eL'+i+': '+JSON.stringify(lines[i]));
console.log('--- searching ---');
for(let i=0;i<lines.length;i++){
    const t = lines[i].trim();
    if(t.includes('connectWallet') || t==='async'){
        console.log('AT eL'+i+': '+JSON.stringify(lines[i]));
        for(let k=Math.max(0,i-2);k<Math.min(lines.length,i+5);k++){
            console.log('  ['+k+'] '+JSON.stringify(lines[k]));
        }
    }
}
