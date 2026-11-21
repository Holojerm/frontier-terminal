// The layers of the hardware supply chain a supplier or a monthly print sits
// in: what the suppliers' rows and the hardware prints are both filed under.

export const SUPPLIER_LAYERS = [
  'chips',
  'memory',
  'foundry',
  'networking',
  'optics',
  'servers',
  'cooling',
  'neocloud',
  'hosting',
] as const
export type SupplierLayer = (typeof SUPPLIER_LAYERS)[number]
