const sharp = require('sharp');
const { join } = require('path');

const svg = `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" rx="90" fill="#4285f4"/>
  <text x="256" y="195" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="bold" font-size="95" fill="#fff">TRACTOR</text>
  <text x="256" y="305" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="600" font-size="75" fill="rgba(255,255,255,0.85)">PARTS</text>
  <text x="256" y="395" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="500" font-size="55" fill="rgba(255,255,255,0.65)">ID</text>
</svg>`;

const buf = Buffer.from(svg);
const pub = join(__dirname, '..', 'public');

(async () => {
  await sharp(buf).resize(512, 512).png().toFile(join(pub, 'icon-512.png'));
  await sharp(buf).resize(192, 192).png().toFile(join(pub, 'icon-192.png'));
  await sharp(buf).resize(512, 512).png().toFile(join(pub, 'icon-maskable-512.png'));
  console.log('Icons generated');
})();
