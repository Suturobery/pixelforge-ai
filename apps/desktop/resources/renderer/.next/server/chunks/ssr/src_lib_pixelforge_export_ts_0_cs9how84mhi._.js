module.exports=[55219,a=>{"use strict";a.i(18379);var b=a.i(46277),c=a.i(27541),d=a.i(98687);function e(a,b,c=1){let d=b.frames.length+2,f=`[gd_resource type="SpriteFrames" load_steps=${d} format=3]

`;for(let d of(f+=`[ext_resource type="Texture2D" path="res://${a}" id="1_tex"]

`,b.frames))f+=`[sub_resource type="AtlasTexture" id="AtlasTexture_${d.globalIndex}"]
atlas = ExtResource("1_tex")
region = Rect2(${d.x*c}, ${d.y*c}, ${d.w*c}, ${d.h*c})

`;let g=[],h=new Set,i=(a,c,d)=>{let e=1e3/d;return b.frames.slice(a,c+1).map(a=>{let b=a.durationMs>0?Number((a.durationMs/e).toFixed(3)):1;return`{
"duration": ${b},
"texture": SubResource("AtlasTexture_${a.globalIndex}")
}`}).join(", ")};for(let a of b.clips){let b=Math.min(60,Math.max(1,a.fps||8)),c=a.name.trim()||`clip_${a.clipId}`;for(let d of(h.has(c)||(h.add(c),g.push(`{
"frames": [${i(a.from,a.to,b)}],
"loop": ${a.loop},
"name": &"${c}",
"speed": ${Number(b.toFixed(2))}
}`)),a.tags)){let c=d.name.trim();!c||h.has(c)||(h.add(c),g.push(`{
"frames": [${i(d.from,d.to,b)}],
"loop": ${a.loop},
"name": &"${c}",
"speed": ${Number(b.toFixed(2))}
}`))}}return f+`[resource]
animations = [${g.join(", ")}]
`}let f=[{name:"PNG image",extensions:["png"]}],g=[{name:"JSON metadata",extensions:["json"]}],h=[{name:"Godot 4 SpriteFrames",extensions:["tres"]}];function i(a){let b=Math.max(a.lastIndexOf("/"),a.lastIndexOf("\\"));return b>0?a.slice(0,b):a}async function j(a,d,e=1,f=!1,g="pixelforge"){let h=f&&!d.includeJson,i=(0,b.x)(a,h?{...d,includeJson:!0}:d),k=await (0,b.f)(i);if(e&&e>1&&(k=await Promise.all(k.map(async a=>{if("png"===a.kind){let d=await (0,c.u)(a.bytes),f=(0,b.N)(d.rgba,d.width,d.height,e),g=await (0,b.Q)(d.width*e,d.height*e,f);return{...a,bytes:g}}try{let b=JSON.parse(new TextDecoder().decode(a.bytes));return"number"==typeof b.frameWidth&&(b.frameWidth*=e),"number"==typeof b.frameHeight&&(b.frameHeight*=e),"number"==typeof b.padding&&(b.padding*=e),"number"==typeof b.spacing&&(b.spacing*=e),Array.isArray(b.frames)&&(b.frames=b.frames.map(a=>({...a,..."number"==typeof a.x?{x:a.x*e}:{},..."number"==typeof a.y?{y:a.y*e}:{},..."number"==typeof a.w?{w:a.w*e}:{},..."number"==typeof a.h?{h:a.h*e}:{}}))),{...a,bytes:new TextEncoder().encode(JSON.stringify(b,null,2)+"\n")}}catch{return a}}))),f){let a=[];for(let b of k)if("json"===b.kind)try{let c=JSON.parse(new TextDecoder().decode(b.bytes)),d=c.clip??{},e="string"==typeof c.image?c.image:b.filename.replace(/\.json$/,"_sheet.png"),f="string"==typeof d.name?d.name:"default",g="number"==typeof d.fps?d.fps:8,h="boolean"!=typeof d.loop||d.loop,i=Array.isArray(d.tags)?d.tags:[],j=Array.isArray(c.frames)?c.frames:[],k=function(a){let{sheetFilename:b,clipName:c,fps:d,loop:e,frames:f,tags:g=[]}=a,h=Math.min(60,Math.max(1,d||8)),i=1e3/h,j=f.length+2,k=`[gd_resource type="SpriteFrames" load_steps=${j} format=3]

`;k+=`[ext_resource type="Texture2D" path="res://${b}" id="1_tex"]

`,f.forEach(a=>{k+=`[sub_resource type="AtlasTexture" id="AtlasTexture_${a.index}"]
atlas = ExtResource("1_tex")
region = Rect2(${a.x}, ${a.y}, ${a.w}, ${a.h})

`});let l=a=>a.map(a=>{let b=a.durationMs&&a.durationMs>0?Number((a.durationMs/i).toFixed(3)):1;return`{
"duration": ${b},
"texture": SubResource("AtlasTexture_${a.index}")
}`}).join(", "),m=[],n=c.trim()||"default";for(let a of(m.push(`{
"frames": [${l(f)}],
"loop": ${e},
"name": &"${n}",
"speed": ${Number(h.toFixed(2))}
}`),g)){let b=Math.max(0,a.from),c=Math.min(f.length-1,a.to);if(b<=c){let d=f.slice(b,c+1);m.push(`{
"frames": [${l(d)}],
"loop": ${e},
"name": &"${a.name.trim()}",
"speed": ${Number(h.toFixed(2))}
}`)}}return k+=`[resource]
animations = [${m.join(", ")}]
`}({sheetFilename:e,clipName:f,fps:g,loop:h,frames:j,tags:i});a.push({filename:b.filename.replace(/\.json$/,".tres"),kind:"tres",bytes:new TextEncoder().encode(k)})}catch{}h&&(k=k.filter(a=>"json"!==a.kind)),k.push(...a)}if("aseprite"===g&&"sheet"===d.format&&d.includeJson){let c=d.sheet??{columns:0,padding:0},f=new Map(a.clips.map(a=>[a.id,a]));k=k.map(d=>{if("json"!==d.kind)return d;try{let g=JSON.parse(new TextDecoder().decode(d.bytes)),h=g.clip?.id?f.get(g.clip.id):a.clips[0],i="string"==typeof g.image?g.image:d.filename.replace(/\.json$/,"_sheet.png");if(!h)return d;let j=(0,b.q)(a,h,c,i,e);return{...d,bytes:new TextEncoder().encode(JSON.stringify(j,null,2)+"\n")}}catch{return d}})}return k}async function k(a,c={}){let d=(0,b.A)(c.baseName||a.name),f=c.scale??1,g={columns:c.columns??0,padding:c.padding??0,spacing:c.spacing??c.padding??0},{rgba:h,layout:i}=(0,b.w)(a,g),j=f>1?(0,b.N)(h,i.width,i.height,f):h,l=`${d}_atlas.png`,m=[{filename:l,kind:"png",bytes:await (0,b.Q)(i.width*f,i.height*f,j)}];if(!1!==c.includeJson){let e="aseprite"===(c.jsonFormat??"aseprite")?(0,b.p)(a,g,l,f):{app:"PixelForge AI",version:2,kind:"master-atlas",image:l,scale:f,width:i.width*f,height:i.height*f,frameWidth:i.frameWidth*f,frameHeight:i.frameHeight*f,columns:i.columns,rows:i.rows,padding:i.padding*f,spacing:i.spacing*f,clips:i.clips,frames:i.frames.map(a=>({...a,x:a.x*f,y:a.y*f,w:a.w*f,h:a.h*f}))};m.push({filename:`${d}_atlas.json`,kind:"json",bytes:new TextEncoder().encode(JSON.stringify(e,null,2)+"\n")})}if(c.includeTres){let a=e(l,i,f);m.push({filename:`${d}_atlas.tres`,kind:"tres",bytes:new TextEncoder().encode(a)})}return m}async function l(a,c){if(!(0,d.y)()){for(let b of a){var e;o((e=b.kind,new Blob([b.bytes],{type:"png"===e?"image/png":"json"===e?"application/json":"text/plain"})),b.filename)}return{status:"saved",filenames:a.map(a=>a.filename),destination:"browser downloads"}}let j=(0,d.i)();if(!j)throw new b.v("WRITE_FAILED","desktop bridge is unavailable");if(1===a.length){let c=a[0],e=await j.project.pickSave({defaultPath:c.filename,filters:"png"===c.kind?f:"tres"===c.kind?h:g});if(e.canceled||!e.path)return{status:"canceled"};let k=[{filename:c.filename,bytes:c.bytes}],l=await (0,b.S)((0,d.z)(),i(e.path),k,{overwrite:!0});if("partial"===l.status)throw new b.v("WRITE_FAILED",`could not write ${l.failures[0].filename}: ${l.failures[0].message}`);return{status:"saved",filenames:[e.path],destination:i(e.path)}}let k=await j.exports.pickDir();if(k.canceled||!k.dir)return{status:"canceled"};let l=await (0,b.S)((0,d.z)(),k.dir,a,{overwrite:c});if("conflicts"===l.status)return{status:"conflicts",conflicts:l.conflicts};if("partial"===l.status){let a=l.failures[0];throw new b.v("WRITE_FAILED",`export partially failed — ${l.written.length} file(s) written, then ${a.filename}: ${a.message}`,{failures:l.failures})}return{status:"saved",filenames:a.map(a=>a.filename),destination:k.dir}}async function m(a,b){let{overwrite:c,scale:d=1,includeTres:e=!1,jsonFormat:f="pixelforge",...g}=b;return l(await j(a,g,d,e,f),c)}async function n(a,b={}){let{overwrite:c,...d}=b;return l(await k(a,d),c)}function o(a,b){let c=URL.createObjectURL(a),d=document.createElement("a");d.href=c,d.download=b,document.body.appendChild(d),d.click(),d.remove(),setTimeout(()=>URL.revokeObjectURL(c),4e3)}async function p(b,c,d,e={}){let{GIFEncoder:f,quantize:g,applyPalette:h}=await a.A(26211),i=e.scale??1,j=e.bg&&"transparent"!==e.bg?e.bg:"#101014",k=parseInt(j.slice(1,3),16)||16,l=parseInt(j.slice(3,5),16)||16,m=parseInt(j.slice(5,7),16)||20,n="transparent"===e.bg,q=f(),r=[[0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]];for(let a=0;a<b.length;a++){let d=b[a],e=d.width*i,f=d.height*i,j=new Uint8Array(e*f*4);for(let a=0;a<f;a++){let b=Math.floor(a/i);for(let c=0;c<e;c++){let f=Math.floor(c/i),g=(b*d.width+f)*4,h=(a*e+c)*4,o=d.data[g+3]/255;if(n){let b=Math.max((r[3&a][3&c]+.5)/16,.04);j[h]=d.data[g],j[h+1]=d.data[g+1],j[h+2]=d.data[g+2],j[h+3]=255*(o>b)}else j[h]=Math.round(d.data[g]*o+k*(1-o)),j[h+1]=Math.round(d.data[g+1]*o+l*(1-o)),j[h+2]=Math.round(d.data[g+2]*o+m*(1-o)),j[h+3]=255}}let o=g(j,n?255:256,{format:"rgb565"}),p=h(j,o,"rgb565"),s={palette:o,delay:c[a]||125,dispose:2};if(n){o.push([0,0,0]);let a=o.length-1;for(let b=0;b<j.length;b+=4)0===j[b+3]&&(p[b/4]=a);s.transparent=!0,s.transparentIndex=a}q.writeFrame(p,e,f,s)}q.finish(),o(new Blob([q.bytes()],{type:"image/gif"}),d)}a.s(["z",0,o,"h",0,p,"P",0,e,"x",0,n,"a",0,m])}];

//# sourceMappingURL=src_lib_pixelforge_export_ts_0_cs9how84mhi._.js.map