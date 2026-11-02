// GPU rental prices from documented, unauthenticated price APIs: Microsoft's
// Azure Retail Prices API and Oracle's Cloud Price List API. Both are list
// prices for on-demand (pay-as-you-go) use.

import { gpuOf, gpuRecipe, type GpuRow } from './gpu-prices'

interface AzureItem {
  currencyCode: string
  retailPrice: number
  unitOfMeasure: string
  armRegionName: string
  armSkuName: string
  skuName: string
  productName: string
  type: string
}

/**
 * GPUs per VM for each Azure H100 size, from Azure's VM size pages (the price
 * API names the SKU, not its GPU count). An unknown size fails the run rather
 * than being divided by a guess.
 */
export const AZURE_GPUS_PER_VM: Readonly<Record<string, number>> = {
  ND96: 8,
  NC40: 1,
  NCC40: 1,
  NC80: 2,
}

/** The ND H100 v5 family is the 8-GPU SXM board; the NC families are H100 NVL cards. */
export function azureRows(body: string): GpuRow[] {
  const doc = JSON.parse(body) as { Items?: AzureItem[]; NextPageLink?: string | null }
  if (!Array.isArray(doc.Items)) throw new Error('not an Azure retail prices page')
  if (doc.NextPageLink) throw new Error('Azure answered with more than one page')
  const rows: GpuRow[] = []
  for (const item of doc.Items) {
    if (item.type !== 'Consumption' || item.currencyCode !== 'USD') continue
    if (/Windows|\bWin\b/.test(item.productName) || /Spot|Low Priority/.test(item.skuName)) continue
    if (item.unitOfMeasure !== '1 Hour')
      throw new Error(`${item.armSkuName}: ${item.unitOfMeasure}`)
    const size = item.armSkuName.match(/^Standard_([A-Z]+\d+)/)?.[1]
    const gpus = size ? AZURE_GPUS_PER_VM[size] : undefined
    if (!gpus) throw new Error(`no GPU count for ${item.armSkuName}`)
    const g = gpuOf(item.armSkuName.replaceAll('_', ' '))
    if (!g) continue
    const nd = item.armSkuName.startsWith('Standard_ND')
    rows.push({
      gpu: g.gpu,
      form_factor: nd ? 'SXM' : 'NVL',
      label: item.armSkuName,
      usd_per_gpu_hour: item.retailPrice / gpus,
      gpus_per_instance: gpus,
      instance_usd_per_hour: item.retailPrice,
      region: item.armRegionName,
      config: item.skuName,
    })
  }
  return rows
}

interface OracleItem {
  partNumber: string
  displayName: string
  metricName: string
  serviceCategory?: string
  currencyCodeLocalizations?: { currencyCode: string; prices: { model: string; value: number }[] }[]
}

/** The "Compute - GPU" parts priced per GPU-hour; the AI Enterprise software licence is not compute. */
export function oracleRows(body: string): GpuRow[] {
  const doc = JSON.parse(body) as { items?: OracleItem[] }
  if (!Array.isArray(doc.items)) throw new Error('not an Oracle price list')
  const rows: GpuRow[] = []
  for (const item of doc.items) {
    if (item.serviceCategory !== 'Compute - GPU' || item.metricName !== 'GPU Per Hour') continue
    if (/AI Enterprise/i.test(item.displayName)) continue
    const g = gpuOf(item.displayName)
    if (!g) continue
    const price = item.currencyCodeLocalizations
      ?.find((c) => c.currencyCode === 'USD')
      ?.prices.find((p) => p.model === 'PAY_AS_YOU_GO')?.value
    if (typeof price !== 'number') throw new Error(`${item.partNumber}: no pay-as-you-go USD price`)
    rows.push({
      ...g,
      label: item.displayName,
      usd_per_gpu_hour: price,
      gpus_per_instance: null,
      instance_usd_per_hour: null,
      region: null,
      config: item.partNumber,
    })
  }
  return rows
}

export const GPU_AZURE = gpuRecipe({
  id: 'gpu-azure',
  company: 'microsoft',
  url: "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Virtual%20Machines'%20and%20priceType%20eq%20'Consumption'%20and%20contains(armSkuName,'H100')",
  ext: 'json',
  description: 'Azure H100 VM pay-as-you-go prices per region (Azure Retail Prices API)',
  rows: azureRows,
})

export const GPU_ORACLE = gpuRecipe({
  id: 'gpu-oracle',
  company: 'oracle',
  url: 'https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=USD',
  ext: 'json',
  description: 'Oracle Cloud GPU pay-as-you-go list prices per GPU-hour (Price List API)',
  rows: oracleRows,
})
