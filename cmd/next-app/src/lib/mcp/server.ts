import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OAuthAccessContext } from '@/lib/oauth/types';
import {
    currentBillOutput,
    dailyUsageOutput,
    listHomesOutput,
    liveStatusOutput,
    smartShiftOutlookOutput,
} from './output-schemas';
import { logEvent } from '@/lib/observability';
import { getAppBaseUrl } from '@/lib/url-utils';
import {
    handleGetCurrentBill,
    handleGetDailyUsage,
    handleGetLiveStatus,
    handleGetSmartShiftOutlook,
    handleListHomes,
    type McpToolResult,
} from './tools';

const READ_ONLY_ANNOTATIONS = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
} as const;

async function runLoggedTool(
    ctx: OAuthAccessContext,
    toolName: string,
    siteId: string | undefined,
    fn: () => Promise<McpToolResult>,
): Promise<McpToolResult> {
    const start = Date.now();
    try {
        const result = await fn();
        logEvent(result.isError ? 'warn' : 'info', result.isError ? 'mcp.tool.failed' : 'mcp.tool.called', {
            grantId: ctx.grantId,
            clientId: ctx.clientId,
            ...(siteId ? { siteId } : {}),
            toolName,
            durationMs: Date.now() - start,
        });
        return result;
    } catch (error) {
        logEvent('error', 'mcp.tool.failed', {
            grantId: ctx.grantId,
            clientId: ctx.clientId,
            ...(siteId ? { siteId } : {}),
            toolName,
            durationMs: Date.now() - start,
            error,
        });
        throw error;
    }
}

export interface McpServerConfig {
    origin?: string;
}

export function createPwusageMcpServer(ctx: OAuthAccessContext, config: McpServerConfig = {}): McpServer {
    const origin = (config.origin ?? getAppBaseUrl()).replace(/\/$/, '');
    const server = new McpServer({
        name: 'pwusage',
        title: 'PWUsage',
        version: '1.0.0',
        websiteUrl: origin,
        icons: [
            {
                src: `${origin}/mcp-icon.png`,
                mimeType: 'image/png',
                sizes: ['256x256'],
            },
            {
                src: `${origin}/icon.png`,
                mimeType: 'image/png',
                sizes: ['1024x1024'],
            },
        ],
    });

    server.registerTool(
        'list_homes',
        {
            description: 'List Powerwall homes authorized for this connection, including timezone, billing start day, and setup status.',
            inputSchema: {},
            outputSchema: listHomesOutput,
            annotations: READ_ONLY_ANNOTATIONS,
        },
        () => runLoggedTool(ctx, 'list_homes', undefined, () => handleListHomes(ctx)),
    );

    server.registerTool(
        'get_live_status',
        {
            description: 'Get live solar generation, home load, grid import/export, battery charging/discharging (all non-negative watts), and state of charge for a Powerwall home.',
            inputSchema: {
                site_id: z.string().optional().describe('Home siteId from list_homes. Optional when only one home is authorized.'),
            },
            outputSchema: liveStatusOutput,
            annotations: READ_ONLY_ANNOTATIONS,
        },
        args => runLoggedTool(ctx, 'get_live_status', args.site_id, () => handleGetLiveStatus(ctx, args)),
    );

    server.registerTool(
        'get_current_bill',
        {
            description: 'Get the current billing cycle summary, TOU period breakdown, export cushion, and estimated cost.',
            inputSchema: {
                site_id: z.string().optional().describe('Home siteId from list_homes. Optional when only one home is authorized.'),
            },
            outputSchema: currentBillOutput,
            annotations: READ_ONLY_ANNOTATIONS,
        },
        args => runLoggedTool(ctx, 'get_current_bill', args.site_id, () => handleGetCurrentBill(ctx, args)),
    );

    server.registerTool(
        'get_smart_shift_outlook',
        {
            description: 'Get upcoming Time-of-Use rate windows and Smart Shift guidance on the best times to run high-load jobs.',
            inputSchema: {
                site_id: z.string().optional().describe('Home siteId from list_homes. Optional when only one home is authorized.'),
            },
            outputSchema: smartShiftOutlookOutput,
            annotations: READ_ONLY_ANNOTATIONS,
        },
        args => runLoggedTool(ctx, 'get_smart_shift_outlook', args.site_id, () => handleGetSmartShiftOutlook(ctx, args)),
    );

    server.registerTool(
        'get_daily_usage',
        {
            description: 'Get daily solar, home load, grid import/export, and battery charge/discharge totals for up to 31 days. '
                + 'Every date up to today is listed with a status: complete (all 5-minute samples), partial (still filling in: '
                + 'today, or a recent day awaiting gap healing), gapped (ended short; totals undercount), no_data (Tesla returned '
                + 'no samples) or missing (not imported). kWh totals are null when a day has no samples.',
            inputSchema: {
                site_id: z.string().optional().describe('Home siteId from list_homes. Optional when only one home is authorized.'),
                from_date: z.string().optional().describe('Start date in YYYY-MM-DD (defaults to 7 days ago).'),
                to_date: z.string().optional().describe('End date in YYYY-MM-DD (defaults to today).'),
            },
            outputSchema: dailyUsageOutput,
            annotations: READ_ONLY_ANNOTATIONS,
        },
        args => runLoggedTool(ctx, 'get_daily_usage', args.site_id, () => handleGetDailyUsage(ctx, args)),
    );

    return server;
}
