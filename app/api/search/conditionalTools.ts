import { serverEnv } from '@/env/server';
import { tool } from 'ai';
import { z } from 'zod';
import { tavily } from '@tavily/core';
import Exa from 'exa-js';
import CodeInterpreter from '@e2b/code-interpreter';
import FirecrawlApp from '@mendable/firecrawl-js';
import MemoryClient from 'mem0ai';

// Helper to check if an environment variable is available
const hasEnv = (key: keyof typeof serverEnv): boolean => {
  return !!serverEnv[key] && serverEnv[key]?.length > 0;
};

// Registry to hold available tools
export const availableTools: Record<string, any> = {};

// Register web search tool (using either Tavily or Exa as fallback)
if (hasEnv('TAVILY_API_KEY')) {
  availableTools.web_search = tool({
    description: 'Search the web for information with 5-10 queries, max results and search depth.',
    parameters: z.object({
      queries: z.array(z.string().describe('Array of search queries to look up on the web. Default is 5 to 10 queries.')),
      maxResults: z.array(
        z.number().describe('Array of maximum number of results to return per query. Default is 10.').default(10),
      ),
      topics: z.array(
        z.enum(['general', 'news', 'finance']).describe('Array of topic types to search for. Default is general.').default('general'),
      ),
      searchDepth: z.array(
        z.enum(['basic', 'advanced']).describe('Array of search depths to use. Default is basic. Use advanced for more detailed results.').default('basic'),
      ),
      exclude_domains: z
        .array(z.string())
        .describe('A list of domains to exclude from all search results. Default is an empty list.').default([]),
    }),
    execute: async ({
      queries,
      maxResults,
      topics,
      searchDepth,
      exclude_domains,
    }: {
      queries: string[];
      maxResults: number[];
      topics: ('general' | 'news' | 'finance')[];
      searchDepth: ('basic' | 'advanced')[];
      exclude_domains?: string[];
    }) => {
      const apiKey = serverEnv.TAVILY_API_KEY || '';
      const tvly = tavily({ apiKey });
      const includeImageDescriptions = true;

      console.log('Queries:', queries);
      console.log('Max Results:', maxResults);
      console.log('Topics:', topics);
      console.log('Search Depths:', searchDepth);
      console.log('Exclude Domains:', exclude_domains);

      // Execute searches in parallel
      const searchPromises = queries.map(async (query, index) => {
        const data = await tvly.search(query, {
          topic: topics[index] || topics[0] || 'general',
          days: topics[index] === 'news' ? 7 : undefined,
          maxResults: maxResults[index] || maxResults[0] || 10,
          searchDepth: searchDepth[index] || searchDepth[0] || 'basic',
          includeAnswer: true,
          includeImages: true,
          includeImageDescriptions: includeImageDescriptions,
          excludeDomains: exclude_domains,
        });

        // Add annotation for query completion
        // Note: dataStream is not available here, so this part would need to be handled in the main route
        return {
          query,
          results: data.results.map((obj: any) => ({
            url: obj.url,
            title: obj.title,
            content: obj.content,
            raw_content: obj.raw_content,
            published_date: topics[index] === 'news' ? obj.published_date : undefined,
          })),
          images: includeImageDescriptions
            ? await Promise.all(
                data.images.map(
                  async ({ url, description }: { url: string; description?: string }) => {
                    // Placeholder for image validation logic
                    return { url, description: description ?? '' };
                  },
                ),
              ).then((results) =>
                results.filter(
                  (image): image is { url: string; description: string } =>
                    image !== null &&
                    typeof image === 'object' &&
                    typeof image.description === 'string' &&
                    image.description !== '',
                ),
              )
            : await Promise.all(
                data.images.map(async ({ url }: { url: string }) => {
                  // Placeholder for image validation logic
                  return url;
                }),
              ).then((results) => results.filter((url) => url !== null) as string[]),
        };
      });

      const searchResults = await Promise.all(searchPromises);

      return {
        searches: searchResults,
      };
    },
  });
} else if (hasEnv('EXA_API_KEY')) {
  // Fallback to Exa for web search if Tavily is not available
  availableTools.web_search = tool({
    description: 'Search the web for information using Exa AI.',
    parameters: z.object({
      query: z.string().describe('The search query for web content'),
    }),
    execute: async ({ query }: { query: string }) => {
      const exa = new Exa(serverEnv.EXA_API_KEY || '');
      const result = await exa.searchAndContents(query, {
        type: 'neural',
        useAutoprompt: true,
        numResults: 10,
        text: true,
        highlights: true,
      });
      return {
        results: result.results.map((post: any) => ({
          url: post.url,
          title: post.title || '',
          content: post.text || '',
        })),
      };
    },
  });
}

// Register academic search (only if Exa is available)
if (hasEnv('EXA_API_KEY')) {
  availableTools.academic_search = tool({
    description: 'Search academic papers and research.',
    parameters: z.object({
      query: z.string().describe('The search query'),
    }),
    execute: async ({ query }: { query: string }) => {
      const exa = new Exa(serverEnv.EXA_API_KEY || '');
      const result = await exa.searchAndContents(query, {
        type: 'auto',
        numResults: 20,
        category: 'research paper',
        summary: {
          query: 'Abstract of the Paper',
        },
      });
      const processedResults = result.results.reduce<typeof result.results>((acc, paper) => {
        if (acc.some((p) => p.url === paper.url) || !paper.summary) return acc;
        const cleanSummary = paper.summary.replace(/^Summary:\s*/i, '');
        const cleanTitle = paper.title?.replace(/\s\[.*?\]$/, '');
        acc.push({
          ...paper,
          title: cleanTitle || '',
          summary: cleanSummary,
        });
        return acc;
      }, []);
      return {
        results: processedResults,
      };
    },
  });
}

// Register code interpreter (only if E2B is available)
if (hasEnv('E2B_API_KEY') && hasEnv('SANDBOX_TEMPLATE_ID')) {
  availableTools.code_interpreter = tool({
    description: 'Write and execute Python code.',
    parameters: z.object({
      title: z.string().describe('The title of the code snippet.'),
      code: z
        .string()
        .describe(
          'The Python code to execute. put the variables in the end of the code to print them. do not use the print function.',
        ),
      icon: z
        .enum(['stock', 'date', 'calculation', 'default'])
        .describe('The icon to display for the code snippet.'),
    }),
    execute: async ({ code, title, icon }: { code: string; title: string; icon: string }) => {
      console.log('Code:', code);
      console.log('Title:', title);
      console.log('Icon:', icon);
      const sandbox = await CodeInterpreter.create(serverEnv.SANDBOX_TEMPLATE_ID || '');
      const execution = await sandbox.runCode(code);
      let message = '';
      if (execution.results.length > 0) {
        for (const result of execution.results) {
          if (result.isMainResult) {
            message += `${result.text}\n`;
          } else {
            message += `${result.text}\n`;
          }
        }
      }
      if (execution.logs.stdout.length > 0 || execution.logs.stderr.length > 0) {
        if (execution.logs.stdout.length > 0) {
          message += `${execution.logs.stdout.join('\n')}\n`;
        }
        if (execution.logs.stderr.length > 0) {
          message += `${execution.logs.stderr.join('\n')}\n`;
        }
      }
      if (execution.error) {
        message += `Error: ${execution.error}\n`;
        console.log('Error: ', execution.error);
      }
      console.log(execution.results);
      if (execution.results[0].chart) {
        execution.results[0].chart.elements.map((element: any) => {
          console.log(element.points);
        });
      }
      return {
        message: message.trim(),
        chart: execution.results[0].chart ?? '',
      };
    },
  });
}

// Register retrieve tool (only if Firecrawl is available)
if (hasEnv('FIRECRAWL_API_KEY')) {
  availableTools.retrieve = tool({
    description: 'Retrieve the information from a URL using Firecrawl.',
    parameters: z.object({
      url: z.string().describe('The URL to retrieve the information from.'),
    }),
    execute: async ({ url }: { url: string }) => {
      const app = new FirecrawlApp({
        apiKey: serverEnv.FIRECRAWL_API_KEY || '',
      });
      try {
        const content = await app.scrapeUrl(url);
        if (!content.success || !content.metadata) {
          return {
            results: [{
              error: content.error
            }]
          };
        }
        const schema = z.object({
          title: z.string(),
          content: z.string(),
          description: z.string()
        });
        let title = content.metadata.title;
        let description = content.metadata.description;
        let extractedContent = content.markdown;
        if (!title || !description || !extractedContent) {
          const extractResult = await app.extract([url], {
            prompt: "Extract the page title, main content, and a brief description.",
            schema: schema
          });
          if (extractResult.success && extractResult.data) {
            title = title || extractResult.data.title;
            description = description || extractResult.data.description;
            extractedContent = extractedContent || extractResult.data.content;
          }
        }
        return {
          results: [
            {
              title: title || 'Untitled',
              content: extractedContent || '',
              url: content.metadata.sourceURL,
              description: description || '',
              language: content.metadata.language,
            },
          ],
        };
      } catch (error) {
        console.error('Firecrawl API error:', error);
        return { error: 'Failed to retrieve content' };
      }
    },
  });
}

// Register memory manager tool (only if Mem0 is available)
if (hasEnv('MEM0_API_KEY') && hasEnv('MEM0_ORG_ID') && hasEnv('MEM0_PROJECT_ID')) {
  availableTools.memory_manager = tool({
    description: 'Manage personal memories with add and search operations.',
    parameters: z.object({
      action: z.enum(['add', 'search']).describe('The memory operation to perform'),
      content: z.string().optional().describe('The memory content for add operation'),
      query: z.string().optional().describe('The search query for search operations'),
    }),
    execute: async ({ action, content, query }: {
      action: 'add' | 'search';
      content?: string;
      query?: string;
    }) => {
      const client = new MemoryClient({ apiKey: serverEnv.MEM0_API_KEY || '' });
      console.log("action", action);
      console.log("content", content);
      console.log("query", query);
      try {
        switch (action) {
          case 'add': {
            if (!content) {
              return {
                success: false,
                action: 'add',
                message: 'Content is required for add operation'
              };
            }
            const result = await client.add(content, {
              user_id: 'user_id_placeholder', // This should be dynamically set in the main route
              org_id: serverEnv.MEM0_ORG_ID || '',
              project_id: serverEnv.MEM0_PROJECT_ID || ''
            });
            if (result.length === 0) {
              return {
                success: false,
                action: 'add',
                message: 'No memory added'
              };
            }
            console.log("result", result);
            return {
              success: true,
              action: 'add',
              memory: result[0]
            };
          }
          case 'search': {
            if (!query) {
              return {
                success: false,
                action: 'search',
                message: 'Query is required for search operation'
              };
            }
            const searchFilters = {
              AND: [
                { user_id: 'user_id_placeholder' }, // This should be dynamically set in the main route
              ]
            };
            const result = await client.search(query, {
              filters: searchFilters,
              api_version: 'v2'
            });
            if (!result || !result[0]) {
              return {
                success: false,
                action: 'search',
                message: 'No results found for the search query'
              };
            }
            return {
              success: true,
              action: 'search',
              results: result[0]
            };
          }
        }
      } catch (error) {
        console.error('Memory operation error:', error);
        throw error;
      }
    },
  });
}

// Add more tools conditionally based on other API keys

// Export the list of available tool names for group configuration
export const availableToolNames = Object.keys(availableTools); 