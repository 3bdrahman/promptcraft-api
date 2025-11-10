// Quick script to verify and fix all imports
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function fixImports() {
  const handlersDir = path.join(__dirname, 'src', 'routes', 'handlers');

  async function processFile(filePath) {
    let content = await fs.readFile(filePath, 'utf8');
    let modified = false;

    // Fix common issues
    const fixes = [
      // Fix shared imports
      [/from ['"]\.\.\/shared\//g, "from '../../../utils/"],
      [/from ['"]\.\.\/\.\.\/shared\//g, "from '../../../utils/"],
      [/from ['"]\.\.\/..\/.\.\/shared\//g, "from '../../../utils/"],

      // Fix auth imports
      [/from ['"]\.\.\/auth\//g, "from '../../../middleware/auth/"],
      [/from ['"]\.\.\/\.\.\/auth\//g, "from '../../../middleware/auth/"],

      // Fix services
      [/from ['"]\.\.\/services\//g, "from '../../../services/"],
      [/from ['"]\.\.\/\.\.\/services\//g, "from '../../../services/"],
    ];

    for (const [pattern, replacement] of fixes) {
      if (pattern.test(content)) {
        content = content.replace(pattern, replacement);
        modified = true;
      }
    }

    if (modified) {
      await fs.writeFile(filePath, content);
      console.log(`✓ Fixed: ${path.relative(__dirname, filePath)}`);
    }
  }

  async function walkDir(dir) {
    const files = await fs.readdir(dir, { withFileTypes: true });

    for (const file of files) {
      const fullPath = path.join(dir, file.name);
      if (file.isDirectory()) {
        await walkDir(fullPath);
      } else if (file.name.endsWith('.js')) {
        await processFile(fullPath);
      }
    }
  }

  await walkDir(handlersDir);
  console.log('\n✅ All imports fixed!');
}

fixImports().catch(console.error);
