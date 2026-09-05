import { readFile,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import sharp from 'sharp';
import ssimModule from 'ssim.js';
const {ssim}=ssimModule;
const report=JSON.parse(await readFile(process.env.ENGINE_REPORT ?? 'benchmark/engines-local.json','utf8'));
const fixtures=process.env.FIXTURES ?? '/tmp/imgt-engine-fixtures';
const outputs=process.env.ENGINE_OUTPUT_DIR ?? '/tmp/imgt-engine-results';
const quality={metric:'ssim.js 3.5.0, Weber SSIM, window 11, no downsampling; white/black alpha composites',
 reference:'Lossless Sharp oriented Lanczos3 resize (existing renderer reference); SSIM alone does not establish perceptual equivalence.',rows:[]};
async function pixels(input,background){
 const {data,info}=await sharp(input).flatten({background}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 return {data,width:info.width,height:info.height};
}
for(const fixture of report.manifest.files){
 const widths=report.profiles[0].rows.filter(r=>r.source===fixture.name).map(r=>r.width);
 for(const width of widths){
  const source=await readFile(join(fixtures,fixture.name));
  const reference=await sharp(source).rotate().resize({width,withoutEnlargement:true,fit:'inside'}).png().toBuffer();
  for(const background of fixture.alpha?['white','black']:['white']){
   const ref=await pixels(reference,background);
   for(const profile of report.profiles){
    if(!profile.rows.find(r=>r.source===fixture.name&&r.width===width)?.runs[0]?.ok)continue;
    const encoded=await readFile(join(outputs,`${profile.name}-${fixture.name}-${width}.webp`));
    const image=await pixels(encoded,background);
    const score=ssim(ref,image,{downsample:false,ssim:'weber',windowSize:11}).mssim;
    const row={profile:profile.name,source:fixture.name,width,background,bytes:encoded.length,
     hash:createHash('sha256').update(encoded).digest('hex'),ssim:score};
    quality.rows.push(row);console.log(JSON.stringify(row));
   }
  }
 }
 await writeFile(process.env.QUALITY_REPORT ?? 'benchmark/engines-quality-local.json',JSON.stringify(quality,null,2)+'\n');
}
