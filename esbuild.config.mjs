import esbuild from 'esbuild';
await esbuild.build({entryPoints:['src/main.ts'],bundle:true,format:'cjs',target:'es2020',external:['obsidian'],loader:{'.svg':'text'},outfile:'main.js'});
