import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import * as https from 'https';
import * as fs from 'fs';

const Electron = require('electron');
const {
	remote: { safeStorage }
} = Electron;

/**
 * Configuration settings for the Wiki.js Publisher plugin
 */
interface WikiJSPublisherSettings {
	/** Base URL of the Wiki.js instance (without trailing slash) */
	wikiJsUrl: string;
	/** Encrypted API token for Wiki.js authentication */
	encryptedApiToken: string | null;
	/** Default tags to apply to all published pages */
	defaultTags: string[];
	/** Front matter key that marks a note for publishing */
	publishFrontMatterKey: string;
	/** Path to custom CA certificate for SSL verification */
	caPath: string;
	/** Whether to sync Obsidian document tags to Wiki.js */
	syncTags: boolean;
	/** Whether to enable debug mode for troubleshooting */
	debugMode: boolean;
	/** Front matter key used for specifying the Wiki.js path prefix */
	pathPrefixKey: string;
}

/**
 * Represents a page in the Wiki.js system
 */
interface WikiPage {
	/** Unique identifier of the page */
	id: number;
	/** Full path of the page in Wiki.js */
	path: string;
	/** Display title of the page */
	title: string;
}

/**
 * Tag cache interface
 */
interface TagCache {
	/** Front matter tags */
	frontmatterTags: string[];
	/** Inline tags */
	inlineTags: string[];
	/** All tags combined */
	allTags: string[];
}

/**
 * Default configuration values
 */
const DEFAULT_SETTINGS: WikiJSPublisherSettings = {
	wikiJsUrl: '',
	encryptedApiToken: null,
	defaultTags: [],
	publishFrontMatterKey: 'wikijs_publish',
	pathPrefixKey: 'wikijs_path_prefix',
	caPath: '',
	syncTags: false,
	debugMode: false
}

/**
 * Logger class for handling plugin logging
 */
class Logger {
	private debugMode: boolean;
	private prefix: string;

	constructor(debugMode: boolean = false, prefix: string = 'WikiJS Publisher') {
		this.debugMode = debugMode;
		this.prefix = prefix;
	}

	setDebugMode(enabled: boolean) {
		this.debugMode = enabled;
	}

	debug(message: string, ...args: any[]) {
		if (this.debugMode) {
			console.log(`${this.prefix} (Debug):`, message, ...args);
		}
	}

	info(message: string, ...args: any[]) {
		if (this.debugMode) {
			console.log(`${this.prefix}:`, message, ...args);
		}
	}

	error(message: string, error?: Error | unknown) {
		// Always log errors regardless of debug mode
		if (error instanceof Error) {
			console.error(`${this.prefix} (Error):`, message, error.message);
			if (this.debugMode) {
				console.error(error.stack);
			}
		} else {
			console.error(`${this.prefix} (Error):`, message, error);
		}
	}

	warn(message: string, ...args: any[]) {
		// Always log warnings regardless of debug mode
		console.warn(`${this.prefix} (Warning):`, message, ...args);
	}
}

/**
 * Wiki.js Publisher plugin main class
 * Handles publishing Obsidian notes to a Wiki.js instance
 */
export default class WikiJSPublisher extends Plugin {
	/** Plugin settings */
	settings: WikiJSPublisherSettings;
	logger: Logger;
	private lastKnownTags: Map<string, TagCache> = new Map();

	/**
	 * Plugin load handler
	 * Sets up commands, ribbon icons, and settings
	 */
	async onload() {
		await this.loadSettings();
		this.logger = new Logger(this.settings.debugMode);

		// Add ribbon icon for single page publish
		const ribbonIconEl = this.addRibbonIcon(
			'upload', 
			'Publish to Wiki.js', 
			(evt: MouseEvent) => {
				this.publishCurrentNote();
			}
		);

		// Add command to publish current note
		this.addCommand({
			id: 'publish-current-note',
			name: 'Publish current note',
			callback: () => this.publishCurrentNote()
		});

		// Add command to publish all marked notes
		this.addCommand({
			id: 'publish-all-marked-notes',
			name: 'Publish all marked notes',
			callback: () => this.publishAllMarkedNotes()
		});

		// Add settings tab
		this.addSettingTab(new WikiJSPublisherSettingTab(this.app, this));

		// Register tag watcher
		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				const oldTags = this.lastKnownTags.get(file.path);
				const newTags = this.getTags(file);
				
				if (JSON.stringify(oldTags) !== JSON.stringify(newTags)) {
					this.logger.debug(`Tags changed in ${file.path}`, {
						old: oldTags,
						new: newTags
					});
					this.lastKnownTags.set(file.path, newTags);
				}
			})
		);
	}

	/**
	 * Loads plugin settings from disk
	 */
	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		if (this.logger) {
			this.logger.setDebugMode(this.settings.debugMode);
		}
	}

	/**
	 * Saves plugin settings to disk
	 */
	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * Validates that required settings are configured
	 * @returns boolean indicating if settings are valid
	 */
	private validateSettings(): boolean {
		const errors: string[] = [];
		
		if (!this.settings.wikiJsUrl) {
			errors.push('Wiki.js URL must be configured');
		} else if (!this.settings.wikiJsUrl.startsWith('http')) {
			errors.push('Wiki.js URL must start with http:// or https://');
		}
		
		if (this.settings.caPath && !fs.existsSync(this.settings.caPath)) {
			errors.push('CA certificate file not found');
		}
		
		if (errors.length > 0) {
			new Notice(errors.join('\n'));
			return false;
		}
		
		return true;
	}

	/**
	 * Custom fetch implementation using Node.js https
	 * Handles SSL certificates and API communication
	 * @param url The URL to fetch
	 * @param options Request options
	 * @returns Promise resolving to response data
	 * @throws Error on request failure
	 */
	async customFetch(url: string, options: any = {}): Promise<any> {
		this.logger.debug("Starting custom fetch");
		const apiToken = this.getApiToken();
		if (!apiToken) {
			throw new Error('API token not configured or cannot be decrypted');
		}

		return new Promise((resolve, reject) => {
			const urlObj = new URL(url);
			
			const httpsOptions: https.RequestOptions = {
				hostname: urlObj.hostname,
				port: urlObj.port || 443,
				path: urlObj.pathname + urlObj.search,
				method: options.method || 'GET',
				headers: {
					...options.headers,
					'Authorization': `Bearer ${apiToken}`,
				},
				rejectUnauthorized: true
			};

			// Add CA certificate if configured
			if (this.settings.caPath) {
				try {
					this.logger.debug(`Loading CA from ${this.settings.caPath}`);
					const ca = fs.readFileSync(this.settings.caPath);
					httpsOptions.ca = ca;
					this.logger.debug("CA certificate loaded successfully");
				} catch (error) {
					this.logger.error("Error loading CA certificate:", error);
					reject(new Error(`Failed to load CA certificate: ${error.message}`));
					return;
				}
			}

			const req = https.request(httpsOptions, (res) => {
				let data = '';

				res.on('data', (chunk) => {
					data += chunk;
				});

				res.on('end', () => {
					this.logger.debug(`Response status: ${res.statusCode}`);
					
					if (res.statusCode >= 200 && res.statusCode < 300) {
						try {
							const jsonData = data ? JSON.parse(data) : {};
							resolve({
								ok: true,
								status: res.statusCode,
								json: () => Promise.resolve(jsonData),
								text: () => Promise.resolve(data)
							});
						} catch (e) {
							this.logger.error("JSON parse error:", e);
							reject(new Error('Invalid JSON response'));
						}
					} else {
						reject(new Error(`HTTP Error: ${res.statusCode} ${data}`));
					}
				});
			});

			req.on('error', (error) => {
				this.logger.error("Request error:", error);
				reject(error);
			});

			if (options.body) {
				req.write(options.body);
			}

			req.end();
		});
	}

	/**
	 * Publishes the currently active note to Wiki.js
	 * Handles content processing and publishing workflow
	 */
	async publishCurrentNote() {
		this.logger.debug('Starting publish process...');
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) {
			this.logger.debug('No active markdown view found');
			new Notice('No active markdown view');
			return;
		}

		const editor = activeView.editor;
		const file = activeView.file;

		if (!file) {
			this.logger.debug('No file is currently open');
			new Notice('No file is currently open');
			return;
		}

		if (!this.validateSettings()) {
			return;
		}

		this.logger.debug(`Processing file: ${file.basename}`);

		try {
			const name = file.basename;
			const rawContent = editor.getValue();
			const frontMatter = this.getFrontMatter(rawContent);
			
			// Check if note should be published using key from settings
			if (!this.shouldPublish(frontMatter)) {
				this.logger.info(`File ${file.basename} is not marked for publishing`);
				new Notice(`This note is not marked for publishing. Add ${this.settings.publishFrontMatterKey}: true to the front matter.`);
				return;
			}

			// Check for empty content after removing frontmatter
			const processedContent = this.removeFrontMatter(rawContent);
			if (!processedContent.trim()) {
				this.logger.info('Cannot publish empty note');
				new Notice('Cannot publish empty note. Please add some content first.');
				return;
			}
			
			// Convert links
			const content = await this.convertObsidianLinks(processedContent);
			const tags = this.getPublishTags(file);
			
			const pathPrefix = frontMatter[this.settings.pathPrefixKey] ? 
				frontMatter[this.settings.pathPrefixKey].replace(/^\/|\/$/g, '') + '/' : 
				'';
			
			const slugifiedPath = pathPrefix + this.slugify(name);
			this.logger.debug('Using path with prefix:', slugifiedPath);
			
			this.logger.debug('Publishing with tags:', tags);

			const {exists, id, path} = await this.checkPageExists(slugifiedPath);
			this.logger.debug(`Page exists: ${exists}, id: ${id}, path: ${path}`);
			
			if (exists && id) {
				this.logger.info('Updating existing Wiki.js page...');
				await this.updateWikiJSPage(name, slugifiedPath, content, tags, id);
				new Notice('Successfully updated page on Wiki.js');
			} else {
				this.logger.info('Creating new Wiki.js page...');
				await this.createWikiJSPage(name, slugifiedPath, content, tags);
				new Notice('Successfully created new page on Wiki.js');
			}
		} catch (error) {
			await this.cleanup();
			this.logger.error('Publishing error:', error);
			new Notice(`Failed to publish: ${error.message}`);
		}
	}

	/**
	 * Publishes all notes marked with the publish frontmatter key
	 * Handles bulk publishing workflow with progress tracking
	 */
	async publishAllMarkedNotes() {
		this.logger.info('Starting bulk publish process...');
		
		if (!this.validateSettings()) {
			return;
		}

		const markdownFiles = this.app.vault.getMarkdownFiles();
		const publishQueue: string[] = [];
		let publishedCount = 0;
		let errorCount = 0;

		// First, scan all files to find those marked for publishing
		for (const file of markdownFiles) {
			try {
				const content = await this.app.vault.read(file);
				const frontMatter = this.getFrontMatter(content);
				
				if (this.shouldPublish(frontMatter)) {
					publishQueue.push(file.path);
				}
			} catch (error) {
				this.logger.error(`Error reading file ${file.path}:`, error);
				errorCount++;
			}
		}

		if (publishQueue.length === 0) {
			this.logger.info('No files marked for publishing found');
			new Notice('No files marked for publishing found');
			return;
		}

		new Notice(`Starting bulk publish: ${publishQueue.length} files found`);

		// Process files one by one
		for (const filePath of publishQueue) {
			try {
				const file = this.app.vault.getAbstractFileByPath(filePath);
				if (!(file instanceof TFile)) {
					this.logger.error(`Invalid file type for ${filePath}`);
					errorCount++;
					continue;
				}

				const content = await this.app.vault.read(file);
				if (!content) {
					this.logger.error(`Could not read content for ${filePath}`);
					errorCount++;
					continue;
				}

				const frontMatter = this.getFrontMatter(content);
				
				// Check for empty content after removing frontmatter
				const processedContent = this.removeFrontMatter(content);
				if (!processedContent.trim()) {
					this.logger.debug(`Skipping empty file: ${file.basename}`);
					errorCount++;
					continue;
				}

				// Get tags using new tag handling system
				const tags = this.getPublishTags(file);
				this.logger.debug(`Publishing ${file.basename} with tags:`, tags);
				
				const pathPrefix = frontMatter[this.settings.pathPrefixKey] ? 
					frontMatter[this.settings.pathPrefixKey].replace(/^\/|\/$/g, '') + '/' : 
					'';
				
				const slugifiedPath = pathPrefix + this.slugify(file.basename);
				
				this.logger.debug(`Publishing to path: ${slugifiedPath}`);
				const {exists, id} = await this.checkPageExists(slugifiedPath);
				
				if (exists && id) {
					this.logger.info(`Updating existing page: ${slugifiedPath}`);
					await this.updateWikiJSPage(file.basename, slugifiedPath, processedContent, tags, id);
				} else {
					this.logger.info(`Creating new page: ${slugifiedPath}`);
					await this.createWikiJSPage(file.basename, slugifiedPath, processedContent, tags);
				}
				
				publishedCount++;
				new Notice(`Published ${publishedCount}/${publishQueue.length}: ${file.basename} (${errorCount} errors)`, 3000);
				
				// Add a small delay between publishes to avoid overwhelming the API
				await new Promise(resolve => setTimeout(resolve, 500));
				
			} catch (error) {
				await this.cleanup();
				this.logger.error(`Error publishing ${filePath}:`, error);
				new Notice(`Failed to publish ${filePath}: ${error.message}`);
				errorCount++;
			}
		}

		if (errorCount > 0) {
			new Notice(`Publishing complete. ${publishedCount} files published. ${errorCount} files failed. Check console for details.`, 10000);
		} else {
			new Notice(`Successfully published ${publishedCount} files!`, 5000);
		}
	}

	/**
	 * Converts Obsidian-style links to Wiki.js markdown links
	 * @param content Content containing Obsidian links
	 * @returns Content with converted markdown links
	 */
	async convertObsidianLinks(content: string): Promise<string> {
		this.logger.debug('Converting Obsidian links...');
		
		// First, get all pages from Wiki.js to build a lookup map
		const pages = await this.getAllWikiPages();
		const pageMap = new Map<string, WikiPage>();
		
		// Build lookup map using slugified titles
		pages.forEach(page => {
			const pathParts = page.path.split('/');
			const slug = pathParts[pathParts.length - 1];
			pageMap.set(slug, page);
		});
		
		// Replace wiki-style links with aliases: [[Page Name|Alias]] -> [Alias](/path/to/page-name)
		content = content.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, (match, target, alias) => {
			this.logger.debug(`Converting aliased link: ${match}`);
			const slugifiedTarget = this.slugify(target);
			const page = pageMap.get(slugifiedTarget);
			
			if (page) {
				this.logger.debug(`Found existing page: ${page.path}`);
				return `[${alias}](/${page.path})`;
			}
			return `[${alias}](/${slugifiedTarget})`;
		});

		// Replace standard wiki-style links: [[Page Name]] -> [Page Name](/path/to/page-name)
		content = content.replace(/\[\[([^\]]+)\]\]/g, (match, target) => {
			// Skip if it's an embed
			if (match.startsWith('!')) {
				this.logger.debug(`Skipping embed: ${match}`);
				return match;
			}
			
			this.logger.debug(`Converting standard link: ${match}`);
			const slugifiedTarget = this.slugify(target);
			const page = pageMap.get(slugifiedTarget);
			
			if (page) {
				this.logger.debug(`Found existing page: ${page.path}`);
				return `[${target}](/${page.path})`;
			}
			return `[${target}](/${slugifiedTarget})`;
		});

		return content;
	}

	/**
	 * Fetches all pages from Wiki.js for link resolution
	 * @returns Array of Wiki.js pages
	 * @throws Error if API request fails
	 */
	async getAllWikiPages(): Promise<WikiPage[]> {
		try {
			this.logger.debug('Fetching all Wiki.js pages...');
			const response = await this.customFetch(`${this.settings.wikiJsUrl}/graphql`, {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${this.getApiToken()}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					query: `query {
						pages {
							list {
								id
								path
								title
							}
						}
					}`
				})
			});

			const data = await response.json();
			if (!data?.data?.pages?.list) {
				this.logger.error('Failed to fetch pages:', data);
				throw new Error('Failed to fetch Wiki.js pages');
			}

			return data.data.pages.list;
		} catch (error) {
			this.logger.error('Error fetching Wiki.js pages:', error);
			throw error;
		}
	}

	/**
	 * Checks if a page exists in Wiki.js
	 * @param path Page path to check
	 * @returns Object containing existence status and page details if found
	 */
	async checkPageExists(path: string): Promise<{exists: boolean, id?: number, path?: string}> {
		try {
			this.logger.debug(`Checking page existence for: ${path}`);
			const pages = await this.getAllWikiPages();
			
			// Find page with matching path
			const page = pages.find(p => p.path === path);
			
			if (page?.id) {
				this.logger.debug(`Found existing page with id: ${page.id} and path: ${page.path}`);
				return {exists: true, id: page.id, path: page.path};
			}

			return {exists: false};

		} catch (error) {
			this.logger.error('Error checking page existence:', error);
			throw error;
		}
	}

	/**
	 * Converts a string to a URL-friendly slug
	 * @param text Text to slugify
	 * @returns URL-friendly slug
	 */
	slugify(text: string): string {
		this.logger.debug('Slugifying text:', text);
		const slugified = text
			.toLowerCase()
			// Handle unicode characters
			.normalize('NFKD')
			.replace(/[\u0300-\u036f]/g, '')
			// Replace non-alphanumeric with dashes
			.replace(/[^a-z0-9-]/g, '-')
			// Normalize multiple dashes to single dash
			.replace(/-+/g, '-')
			// Remove leading/trailing dashes
			.replace(/(^-|-$)/g, '');
		this.logger.debug('Slugified result:', slugified);
		return slugified;
	}

	/**
	 * Extracts and parses front matter from content
	 * @param content Raw file content
	 * @returns Parsed front matter object
	 */
	getFrontMatter(content: string): Record<string, any> {
		this.logger.debug('Parsing front matter...');
		const frontMatterRegex = /^---\s*\n([\s\S]*?)\n---/;
		const match = content.match(frontMatterRegex);
		
		if (!match) {
			this.logger.debug('No front matter found');
			return {};
		}

		this.logger.debug('Front matter raw match:', match[1]);

		const frontMatter: Record<string, any> = {};
		const lines = match[1].split('\n').filter(line => line.trim() !== '');
		
		for (const line of lines) {
			const keyMatch = line.match(/^([^:]+):\s*(.*)$/);
			if (!keyMatch) {
				this.logger.debug(`Skipping invalid front matter line: ${line}`);
				continue;
			}

			const [_, key, initialValue] = keyMatch;
			const trimmedKey = key.trim();
			const trimmedValue = initialValue.trim();

			frontMatter[trimmedKey] = this.parseFrontMatterValue(trimmedValue, trimmedKey);
		}

		this.logger.debug('Complete front matter object:', frontMatter);
		return frontMatter;
	}

	/**
	 * Parses a front matter value, handling different data types
	 * @param value Raw value string
	 * @param key Front matter key (for logging)
	 * @returns Parsed value (string, number, boolean, or array)
	 */
	parseFrontMatterValue(value: string, key: string): any {
		this.logger.debug(`Parsing value: ${value} for key: ${key}`);
		
		// Handle quoted strings with escaped quotes
		if ((value.startsWith('"') && value.endsWith('"')) || 
			(value.startsWith("'") && value.endsWith("'"))) {
			const unquoted = value.slice(1, -1).replace(/\\["']/g, match => match[1]);
			this.logger.debug(`Unquoted string value: ${unquoted}`);
			return unquoted;
		}

		if (value.toLowerCase() === 'true' || value.toLowerCase() === 'false') {
			const parsed = value.toLowerCase() === 'true';
			this.logger.debug(`Parsed boolean value: ${parsed}`);
			return parsed;
		}

		if (!isNaN(Number(value)) && value !== '') {
			const parsed = Number(value);
			this.logger.debug(`Parsed numeric value: ${parsed}`);
			return parsed;
		}

		this.logger.debug(`Using raw value: ${value}`);
		return value;
	}

	/**
	 * Checks if a note should be published based on front matter
	 * @param frontMatter Parsed front matter object
	 * @returns boolean indicating if note should be published
	 */
	shouldPublish(frontMatter: Record<string, any>): boolean {
		const publishValue = frontMatter[this.settings.publishFrontMatterKey];
		this.logger.debug(`Checking publish value for key "${this.settings.publishFrontMatterKey}": ${publishValue} (${typeof publishValue})`);
		
		const trueValues = [true, 'true', '"true"', "'true'", 'True', 'TRUE'];
		const shouldPublish = trueValues.includes(publishValue);
		this.logger.debug(`Should publish: ${shouldPublish}`);
		return shouldPublish;
	}

	/**
	 * Gets tags from front matter and combines with default tags
	 * @param frontMatter Parsed front matter object
	 * @returns Array of combined tags
	 */
	getPublishTags(file: TFile): string[] {
		this.logger.debug('Getting tags for publishing');
		
		// Start with default tags
		let tags = [...this.settings.defaultTags];
		
		// Add document tags if sync is enabled
		if (this.settings.syncTags) {
			const {allTags} = this.getTags(file);
			tags.push(...allTags);
		}
		
		// Remove duplicates and empty tags
		return [...new Set(tags)].filter(tag => tag && tag.trim().length > 0);
	}

	/**
	 * Creates a new page in Wiki.js
	 * @param name Page title
	 * @param path Page path
	 * @param content Page content
	 * @param tags Page tags
	 * @throws Error if page creation fails
	 */
	async createWikiJSPage(name: string, path: string, content: string, tags: string[]) {
		this.logger.debug(`Creating new page: ${name} at path: ${path}`);
		const response = await this.customFetch(`${this.settings.wikiJsUrl}/graphql`, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${this.getApiToken()}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				query: `mutation ($content: String!, $description: String!, $editor: String!, $isPublished: Boolean!, $isPrivate: Boolean!, $locale: String!, $path: String!, $tags: [String]!, $title: String!) {
					pages {
						create(
							content: $content,
							description: $description,
							editor: $editor,
							isPublished: $isPublished,
							isPrivate: $isPrivate,
							locale: $locale,
							path: $path,
							tags: $tags,
							title: $title
						) {
							responseResult {
								succeeded
								errorCode
								message
							}
						}
					}
				}`,
				variables: {
					content: content,
					description: name,
					editor: 'markdown',
					isPublished: true,
					isPrivate: false,
					locale: 'en',
					path: path,
					tags: tags,
					title: name
				}
			})
		});

		const data = await response.json();
		
		if (!data?.data?.pages?.create?.responseResult?.succeeded) {
			const error = data?.data?.pages?.create?.responseResult?.message || 
						 data?.errors?.[0]?.message || 
						 'Unknown error creating page';
			throw new Error(`Failed to create page: ${error}`);
		}

		return data.data.pages.create;
	}

	/**
	 * Updates an existing page in Wiki.js
	 * @param name Page title
	 * @param path Page path
	 * @param content Page content
	 * @param tags Page tags
	 * @param id Page ID
	 * @throws Error if page update fails
	 */
	async updateWikiJSPage(name: string, path: string, content: string, tags: string[], id: number) {
		this.logger.debug(`Updating page: ${name} at path: ${path} with id: ${id}`);

		const response = await this.customFetch(`${this.settings.wikiJsUrl}/graphql`, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${this.getApiToken()}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				query: `mutation ($id: Int!, $content: String!, $description: String!, $editor: String!, $isPublished: Boolean!, $isPrivate: Boolean!, $locale: String!, $path: String!, $tags: [String]!, $title: String!) {
					pages {
						update(
							id: $id,
							content: $content,
							description: $description,
							editor: $editor,
							isPublished: $isPublished,
							isPrivate: $isPrivate,
							locale: $locale,
							path: $path,
							tags: $tags,
							title: $title
						) {
							responseResult {
								succeeded
								errorCode
								message
							}
						}
					}
				}`,
				variables: {
					id: id,
					content: content,
					description: name,
					editor: 'markdown',
					isPublished: true,
					isPrivate: false,
					locale: 'en',
					path: path,
					tags: tags,
					title: name
				}
			})
		});

		const data = await response.json();
		
		if (!data?.data?.pages?.update?.responseResult?.succeeded) {
			const error = data?.data?.pages?.update?.responseResult?.message || 
						 data?.errors?.[0]?.message || 
						 'Unknown error updating page';
			throw new Error(`Failed to update page: ${error}`);
		}

		return data.data.pages.update;
	}

	/**
	 * Removes front matter section from content
	 * @param content Raw file content
	 * @returns Content without front matter
	 */
	removeFrontMatter(content: string): string {
		this.logger.debug('Removing front matter...');
		const frontMatterRegex = /^---\s*\n([\s\S]*?)\n---/;
		const match = content.match(frontMatterRegex);
		
		if (!match) {
			this.logger.debug('No front matter found');
			return content;
		}

		const processedContent = content.slice(match[0].length).trim();
		this.logger.debug('Processed content length:', processedContent.length);
		return processedContent;
	}

	async setApiToken(token: string) {
		try {
			if (!token) {
				this.settings.encryptedApiToken = null;
			} else {
				const encryptedBuffer = safeStorage.encryptString(token);
				this.settings.encryptedApiToken = encryptedBuffer.toString('base64');
			}
			await this.saveSettings();
			new Notice('API token updated successfully');
		} catch (error) {
			this.logger.error('Failed to encrypt API token:', error);
			new Notice('Failed to save API token securely');
		}
	}

	getApiToken(): string | null {
		try {
			if (!this.settings.encryptedApiToken) {
				return null;
			}
			const encryptedBuffer = Buffer.from(this.settings.encryptedApiToken, 'base64');
			return safeStorage.decryptString(encryptedBuffer);
		} catch (error) {
			this.logger.error('Failed to decrypt API token:', error);
			return null;
		}
	}

	getTags(file: TFile): TagCache {
		const cache = this.app.metadataCache.getFileCache(file);
		const result: TagCache = {
			frontmatterTags: [],
			inlineTags: [],
			allTags: []
		};

		if (!cache) {
			this.logger.debug(`No cache found for file: ${file.path}`);
			return result;
		}

		// Get frontmatter tags
		if (cache.frontmatter?.tags) {
			const fmTags = cache.frontmatter.tags;
			if (Array.isArray(fmTags)) {
				result.frontmatterTags = fmTags.map(t => t.toString());
			} else if (typeof fmTags === 'string') {
				result.frontmatterTags = fmTags.split(',').map(t => t.trim());
			}
		}

		// Get inline tags
		if (cache.tags?.length > 0) {
			result.inlineTags = cache.tags.map(t => t.tag.substring(1)); // Remove # prefix
		}

		// Combine all tags and remove duplicates
		result.allTags = [...new Set([...result.frontmatterTags, ...result.inlineTags])];

		this.logger.debug('Found tags:', result);
		return result;
	}

	onunload() {
		// Clear tag cache
		this.lastKnownTags.clear();
		
		// Log unload
		this.logger.info('Wiki.js Publisher plugin unloaded');
		
		// No need to manually remove events or commands as they're handled by Plugin class
		// No need to manually remove settings tab as it's handled by Plugin class
		// No need to clear secure storage as it's handled by OS
	}

	// Helper method to clean up resources if needed during runtime
	async cleanup() {
		this.lastKnownTags.clear();
		await this.saveSettings();
	}
}

/**
 * Settings tab for the Wiki.js Publisher plugin
 * Handles settings UI and validation
 */
class WikiJSPublisherSettingTab extends PluginSettingTab {
	plugin: WikiJSPublisher;

	constructor(app: App, plugin: WikiJSPublisher) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * Renders the settings UI
	 */
	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		// Connection settings (no heading needed as these are general settings)
		new Setting(containerEl)
			.setName('Wiki.js URL')
			.setDesc('URL of your Wiki.js instance (without trailing slash)')
			.addText(text => text
				.setPlaceholder('https://wiki.example.com')
				.setValue(this.plugin.settings.wikiJsUrl)
				.onChange(async (value) => {
					this.plugin.settings.wikiJsUrl = value.replace(/\/$/, '');
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('API token')
			.setDesc('API token from Wiki.js with write permissions (stored securely)')
			.addText(text => {
				text.inputEl.type = 'password';
				text.setPlaceholder('Enter your API token')
					.setValue(this.plugin.getApiToken() || '')
					.onChange(async (value) => {
						await this.plugin.setApiToken(value);
					});
			});

		// Publishing options
		new Setting(containerEl).setName('Publishing').setHeading();

		new Setting(containerEl)
			.setName('Default tags')
			.setDesc('Default tags to apply to all published pages (comma-separated)')
			.addText(text => text
				.setPlaceholder('obsidian, notes')
				.setValue(this.plugin.settings.defaultTags.join(', '))
				.onChange(async (value) => {
					this.plugin.settings.defaultTags = value
						.split(',')
						.map(tag => tag.trim())
						.filter(tag => tag.length > 0);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Publish front matter key')
			.setDesc('Front matter key that marks a note for publishing')
			.addText(text => text
				.setPlaceholder('wikijs_publish')
				.setValue(this.plugin.settings.publishFrontMatterKey)
				.onChange(async (value) => {
					this.plugin.settings.publishFrontMatterKey = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Path prefix key')
			.setDesc('Front matter key used for specifying the Wiki.js path prefix')
			.addText(text => text
				.setPlaceholder('wikijs_path_prefix')
				.setValue(this.plugin.settings.pathPrefixKey)
				.onChange(async (value) => {
					this.plugin.settings.pathPrefixKey = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Sync tags')
			.setDesc('Sync Obsidian document tags to Wiki.js (in addition to default tags)')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncTags)
				.onChange(async (value) => {
					this.plugin.settings.syncTags = value;
					await this.plugin.saveSettings();
				}));

		// Advanced options
		new Setting(containerEl).setName('Advanced').setHeading();

		new Setting(containerEl)
			.setName('CA certificate path')
			.setDesc('Path to custom CA certificate for SSL verification (optional)')
			.addText(text => text
				.setPlaceholder('/path/to/ca.crt')
				.setValue(this.plugin.settings.caPath)
				.onChange(async (value) => {
					this.plugin.settings.caPath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Debug mode')
			.setDesc('Enable detailed logging for troubleshooting')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.debugMode)
				.onChange(async (value) => {
					this.plugin.settings.debugMode = value;
					this.plugin.logger.setDebugMode(value);
					await this.plugin.saveSettings();
				}));
	}
}
