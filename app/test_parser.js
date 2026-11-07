const {parseScript}=require('./src/parser');
const cases={
 sample:`[组 1:begin][STD]\n[分镜 1:begin]\n足立零：XXX\n[分镜 1:end]\n[组 1:end]`,
 tst:`[组 2:begin][TST]\n[分镜 1:begin]\n王马小吉:222\n[分镜 1:end]\n[组 2:end]`,
 missingType:`[组 1:begin]\n[分镜 1:begin]\n旁白：你好\n[分镜 1:end]\n[组 1:end]`,
 implicit:`[组 1:begin][STD]\n旁白：直接台词\n[组 1:end]`,
 colonText:`[组 1:begin][STD]\n[分镜 1:begin]\n足立零：他说：你好\n[分镜 1:end]\n[组 1:end]`,
};
for(const [k,v] of Object.entries(cases)){ const r=parseScript(v); console.log(k,'groups',r.groups.length,'lines',r.stats.lines,'errors',r.errors.map(e=>e.message),'warnings',r.warnings.map(w=>w.message)); }
