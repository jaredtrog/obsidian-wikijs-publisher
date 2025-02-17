# Obsidian Wiki.js Publisher

A simple plugin that integrates Obsidian with Wiki.js, enabling publishing of your notes.

## Key Features

✨ **Publishing Options**
- One-click publishing via ribbon icon or command palette
- Bulk publishing for multiple notes
- Custom path prefixes for organizing content

🔄 **Smart Content Handling**
- Automatic conversion of Obsidian-style links to Wiki.js format
- Intelligent tag synchronization from front matter or document body
- Empty content detection
- Supports the use of a custom CA certificate for self-signed certificates or private certificate authorities

🔒 **Security & Reliability**
- Encrypted API token storage using Electron's safeStorage
- Detailed debug logging for troubleshooting

## Quick Start

1. Install from Obsidian's Community Plugins
2. Enter your Wiki.js URL and API token in settings
3. Add to your note's front matter:

```markdown
---
wikijs_publish: true
---
``` 

## Configuration

The following settings can be configured:

- **Wiki.js URL**: The base URL of your Wiki.js instance  
- **API Token**: Your Wiki.js API token (stored securely)
- **Default Tags**: Tags to apply to all published pages
- **Publish Front Matter Key**: Key that marks notes for publishing (default: `wikijs_publish`)
- **Path Prefix Key**: Key that specifies the Wiki.js path prefix (default: `wikijs_path_prefix`)
- **CA Certificate Path**: Optional path to custom SSL certificate
- **Sync Tags**: Option to sync Obsidian tags to Wiki.js
- **Debug Mode**: Enable detailed logging

## Usage

### Publishing a Single Note

1. Add to your note's front matter:

```markdown
---
wikijs_publish: true
---
```

2. Publish the note using the ribbon icon or command palette

### Bulk Publishing

1. Add `wikijs_publish: true` to the front matter of all notes you want to publish or configure the `publishFrontMatterKey` in settings
2. Use the ribbon icon or command palette to publish all notes marked for publishing

### Custom Path Prefixes

1. Configure a custom path prefix in settings
2. Add notes to folders matching the prefix
3. Publish notes as usual

### Tag Synchronization

1. Default tags are applied to all published pages
2. Document tags are added to the default tags if the `syncTags` setting is enabled

## Troubleshooting

### Common Issues

1. **API Token Not Found**: Ensure your token is correct and has the necessary permissions
2. **SSL Certificate Error**: Check your CA certificate path or disable SSL verification in settings. This is only needed if you are using a self-signed certificate or a certificate from a non-trusted certificate authority for your Wiki.js instance.

### Debugging

1. Enable debug mode in settings
2. Check the console for detailed logs (ctrl+shift+i)