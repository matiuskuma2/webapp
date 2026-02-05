/**
 * Infrastructure Cost Utilities
 * 
 * AWS Cost Explorer API and Cloudflare Analytics API integration
 * for real-time infrastructure cost tracking.
 * 
 * SSOT: This module provides actual infrastructure costs (not estimates)
 * 
 * AWS Cost Explorer:
 * - Lambda execution costs
 * - S3 storage costs
 * - Data transfer costs
 * 
 * Cloudflare Analytics:
 * - Workers requests/CPU time
 * - R2 storage operations
 * - D1 row operations
 */

// ====================================================================
// Types
// ====================================================================

export interface AWSCostResult {
  success: boolean;
  data?: {
    totalCost: number;
    currency: string;
    services: {
      service: string;
      cost: number;
    }[];
    period: {
      start: string;
      end: string;
    };
  };
  error?: string;
}

export interface CloudflareCostResult {
  success: boolean;
  data?: {
    workers: {
      requests: number;
      cpuTimeMs: number;
      estimatedCost: number;  // Based on pricing: $0.15/million requests after free tier
    };
    r2?: {
      classAOperations: number;  // PUT, POST, LIST: $4.50/million
      classBOperations: number;  // GET, HEAD: $0.36/million
      storageBytes: number;      // $0.015/GB/month
      estimatedCost: number;
    };
    d1?: {
      rowsRead: number;   // $0.001/million rows read (after 25B free)
      rowsWritten: number; // $1.00/million rows written (after 50M free)
      estimatedCost: number;
    };
    period: {
      start: string;
      end: string;
    };
    totalEstimatedCost: number;
  };
  error?: string;
}

export interface InfrastructureCostSummary {
  aws: AWSCostResult;
  cloudflare: CloudflareCostResult;
  totalCost: number;
  fetchedAt: string;
}

// ====================================================================
// AWS Cost Explorer API
// ====================================================================

/**
 * Fetch AWS costs using Cost Explorer API
 * Note: Cost Explorer API itself costs $0.01 per request
 * 
 * @param accessKeyId AWS Access Key ID
 * @param secretAccessKey AWS Secret Access Key
 * @param region AWS Region (default: us-east-1 for Cost Explorer)
 * @param days Number of days to look back (default: 30)
 */
export async function fetchAWSCosts(
  accessKeyId: string,
  secretAccessKey: string,
  region: string = 'us-east-1',
  days: number = 30
): Promise<AWSCostResult> {
  try {
    // Calculate date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    
    const start = startDate.toISOString().split('T')[0];
    const end = endDate.toISOString().split('T')[0];
    
    // AWS Signature V4 signing
    const service = 'ce';  // Cost Explorer
    const host = `${service}.${region}.amazonaws.com`;
    const endpoint = `https://${host}`;
    
    const requestBody = JSON.stringify({
      TimePeriod: {
        Start: start,
        End: end
      },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
      GroupBy: [
        {
          Type: 'DIMENSION',
          Key: 'SERVICE'
        }
      ],
      Filter: {
        Dimensions: {
          Key: 'SERVICE',
          Values: [
            'AWS Lambda',
            'Amazon Simple Storage Service',
            'AWS Data Transfer'
          ]
        }
      }
    });
    
    // Create AWS Signature V4
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    
    const canonicalUri = '/';
    const canonicalQuerystring = '';
    const contentType = 'application/x-amz-json-1.1';
    const amzTarget = 'AWSInsightsIndexService.GetCostAndUsage';
    
    // Create canonical headers
    const canonicalHeaders = 
      `content-type:${contentType}\n` +
      `host:${host}\n` +
      `x-amz-date:${amzDate}\n` +
      `x-amz-target:${amzTarget}\n`;
    
    const signedHeaders = 'content-type;host;x-amz-date;x-amz-target';
    
    // Hash the payload
    const payloadHash = await sha256Hex(requestBody);
    
    // Create canonical request
    const canonicalRequest = 
      `POST\n${canonicalUri}\n${canonicalQuerystring}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    
    // Create string to sign
    const algorithm = 'AWS4-HMAC-SHA256';
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const canonicalRequestHash = await sha256Hex(canonicalRequest);
    const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${canonicalRequestHash}`;
    
    // Calculate signature
    const signingKey = await getSignatureKey(secretAccessKey, dateStamp, region, service);
    const signature = await hmacSha256Hex(signingKey, stringToSign);
    
    // Create authorization header
    const authorizationHeader = 
      `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    
    // Make the request
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'Host': host,
        'X-Amz-Date': amzDate,
        'X-Amz-Target': amzTarget,
        'Authorization': authorizationHeader
      },
      body: requestBody
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[AWS Cost] API error:', response.status, errorText);
      return {
        success: false,
        error: `AWS API error: ${response.status} - ${errorText.slice(0, 200)}`
      };
    }
    
    const result = await response.json() as any;
    
    // Parse results
    const services: { service: string; cost: number }[] = [];
    let totalCost = 0;
    
    for (const resultByTime of result.ResultsByTime || []) {
      for (const group of resultByTime.Groups || []) {
        const serviceName = group.Keys?.[0] || 'Unknown';
        const cost = parseFloat(group.Metrics?.UnblendedCost?.Amount || '0');
        
        // Aggregate by service
        const existing = services.find(s => s.service === serviceName);
        if (existing) {
          existing.cost += cost;
        } else {
          services.push({ service: serviceName, cost });
        }
        totalCost += cost;
      }
    }
    
    return {
      success: true,
      data: {
        totalCost: Math.round(totalCost * 100) / 100,
        currency: 'USD',
        services: services.sort((a, b) => b.cost - a.cost),
        period: { start, end }
      }
    };
    
  } catch (error) {
    console.error('[AWS Cost] Error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

// ====================================================================
// Cloudflare Analytics GraphQL API
// ====================================================================

/**
 * Fetch Cloudflare Workers/R2/D1 usage using GraphQL Analytics API
 * 
 * @param accountId Cloudflare Account ID
 * @param apiToken Cloudflare API Token with Analytics:Read permission
 * @param days Number of days to look back (default: 30)
 */
export async function fetchCloudflareCosts(
  accountId: string,
  apiToken: string,
  days: number = 30
): Promise<CloudflareCostResult> {
  try {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    
    const start = startDate.toISOString().split('T')[0];
    const end = endDate.toISOString().split('T')[0];
    
    // GraphQL query for Workers Analytics
    const query = `
      query WorkersAnalytics($accountTag: String!, $since: Date!, $until: Date!) {
        viewer {
          accounts(filter: {accountTag: $accountTag}) {
            workersInvocationsAdaptive(
              filter: {date_geq: $since, date_leq: $until}
              limit: 10000
            ) {
              sum {
                requests
                cpuTime
              }
            }
            r2OperationsAdaptive(
              filter: {date_geq: $since, date_leq: $until}
              limit: 10000
            ) {
              sum {
                requests
              }
              dimensions {
                actionType
              }
            }
            d1AnalyticsAdaptive(
              filter: {date_geq: $since, date_leq: $until}
              limit: 10000
            ) {
              sum {
                readQueries
                writeQueries
                rowsRead
                rowsWritten
              }
            }
          }
        }
      }
    `;
    
    const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiToken}`
      },
      body: JSON.stringify({
        query,
        variables: {
          accountTag: accountId,
          since: start,
          until: end
        }
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Cloudflare] API error:', response.status, errorText);
      return {
        success: false,
        error: `Cloudflare API error: ${response.status}`
      };
    }
    
    const result = await response.json() as any;
    
    if (result.errors && result.errors.length > 0) {
      console.error('[Cloudflare] GraphQL errors:', result.errors);
      return {
        success: false,
        error: `GraphQL error: ${result.errors[0]?.message || 'Unknown'}`
      };
    }
    
    const accounts = result.data?.viewer?.accounts?.[0];
    
    // Parse Workers data
    const workersData = accounts?.workersInvocationsAdaptive?.[0]?.sum || {};
    const requests = workersData.requests || 0;
    const cpuTimeMs = workersData.cpuTime || 0;
    
    // Workers pricing: $0.50/million requests (after 10M free), $0.02/million CPU ms (after 30M free)
    const workersRequestCost = Math.max(0, (requests - 10_000_000) / 1_000_000) * 0.50;
    const workersCpuCost = Math.max(0, (cpuTimeMs - 30_000_000) / 1_000_000) * 0.02;
    const workersEstimatedCost = Math.round((workersRequestCost + workersCpuCost) * 100) / 100;
    
    // Parse R2 data
    let r2ClassA = 0;
    let r2ClassB = 0;
    for (const r2Op of accounts?.r2OperationsAdaptive || []) {
      const actionType = r2Op.dimensions?.actionType || '';
      const opRequests = r2Op.sum?.requests || 0;
      
      // Class A: PUT, POST, LIST, etc.
      // Class B: GET, HEAD
      if (['PutObject', 'ListObjectsV2', 'CreateMultipartUpload', 'CompleteMultipartUpload'].includes(actionType)) {
        r2ClassA += opRequests;
      } else if (['GetObject', 'HeadObject'].includes(actionType)) {
        r2ClassB += opRequests;
      }
    }
    
    // R2 pricing: Class A $4.50/million, Class B $0.36/million
    const r2ClassACost = (r2ClassA / 1_000_000) * 4.50;
    const r2ClassBCost = (r2ClassB / 1_000_000) * 0.36;
    const r2EstimatedCost = Math.round((r2ClassACost + r2ClassBCost) * 100) / 100;
    
    // Parse D1 data
    const d1Data = accounts?.d1AnalyticsAdaptive?.[0]?.sum || {};
    const rowsRead = d1Data.rowsRead || 0;
    const rowsWritten = d1Data.rowsWritten || 0;
    
    // D1 pricing: $0.001/million rows read (after 25B free), $1.00/million rows written (after 50M free)
    const d1ReadCost = Math.max(0, (rowsRead - 25_000_000_000) / 1_000_000) * 0.001;
    const d1WriteCost = Math.max(0, (rowsWritten - 50_000_000) / 1_000_000) * 1.00;
    const d1EstimatedCost = Math.round((d1ReadCost + d1WriteCost) * 100) / 100;
    
    const totalEstimatedCost = workersEstimatedCost + r2EstimatedCost + d1EstimatedCost;
    
    return {
      success: true,
      data: {
        workers: {
          requests,
          cpuTimeMs,
          estimatedCost: workersEstimatedCost
        },
        r2: {
          classAOperations: r2ClassA,
          classBOperations: r2ClassB,
          storageBytes: 0,  // Not available in this query
          estimatedCost: r2EstimatedCost
        },
        d1: {
          rowsRead,
          rowsWritten,
          estimatedCost: d1EstimatedCost
        },
        period: { start, end },
        totalEstimatedCost: Math.round(totalEstimatedCost * 100) / 100
      }
    };
    
  } catch (error) {
    console.error('[Cloudflare] Error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

// ====================================================================
// Combined Infrastructure Cost Summary
// ====================================================================

/**
 * Fetch combined infrastructure costs from AWS and Cloudflare
 */
export async function fetchInfrastructureCosts(
  awsConfig: { accessKeyId: string; secretAccessKey: string; region?: string } | null,
  cloudflareConfig: { accountId: string; apiToken: string } | null,
  days: number = 30
): Promise<InfrastructureCostSummary> {
  const [awsResult, cloudflareResult] = await Promise.all([
    awsConfig 
      ? fetchAWSCosts(awsConfig.accessKeyId, awsConfig.secretAccessKey, awsConfig.region, days)
      : Promise.resolve({ success: false, error: 'AWS credentials not configured' } as AWSCostResult),
    cloudflareConfig
      ? fetchCloudflareCosts(cloudflareConfig.accountId, cloudflareConfig.apiToken, days)
      : Promise.resolve({ success: false, error: 'Cloudflare credentials not configured' } as CloudflareCostResult)
  ]);
  
  const totalCost = 
    (awsResult.data?.totalCost || 0) + 
    (cloudflareResult.data?.totalEstimatedCost || 0);
  
  return {
    aws: awsResult,
    cloudflare: cloudflareResult,
    totalCost: Math.round(totalCost * 100) / 100,
    fetchedAt: new Date().toISOString()
  };
}

// ====================================================================
// AWS Signature V4 Helpers
// ====================================================================

async function sha256(message: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  return await crypto.subtle.digest('SHA-256', data);
}

async function sha256Hex(message: string): Promise<string> {
  const hashBuffer = await sha256(message);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256(key: ArrayBuffer, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const encoder = new TextEncoder();
  return await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
}

async function hmacSha256Hex(key: ArrayBuffer, message: string): Promise<string> {
  const signatureBuffer = await hmacSha256(key, message);
  const signatureArray = Array.from(new Uint8Array(signatureBuffer));
  return signatureArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getSignatureKey(
  key: string,
  dateStamp: string,
  regionName: string,
  serviceName: string
): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const kDate = await hmacSha256(encoder.encode('AWS4' + key), dateStamp);
  const kRegion = await hmacSha256(kDate, regionName);
  const kService = await hmacSha256(kRegion, serviceName);
  return await hmacSha256(kService, 'aws4_request');
}
