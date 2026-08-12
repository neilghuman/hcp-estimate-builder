export const SITERECON_RULES = {
  rulesVersion: 1,
  source: 'siterecon',
  defaults: {
    optionNames: {
      best: 'Best',
      better: 'Better',
      good: 'Good',
    },
    quantityPrecision: 4,
  },
  layerMappings: {
    turf: { labels: ['Turf', 'Lawn'], pricebookItemId: 217, unit: 'sq ft', category: 'Turf Care', active: true },
    mulchBeds: { labels: ['Mulch Beds', 'Mulch'], pricebookItemId: 218, unit: 'sq ft', category: 'Beds & Mulch', active: true },
    flowerBeds: { labels: ['Flower Beds', 'Flower Bed'], pricebookItemId: 219, unit: 'sq ft', category: 'Beds & Mulch', active: true },
    rockBeds: { labels: ['Rock Beds', 'Decorative Rock'], pricebookItemId: 220, unit: 'sq ft', category: 'Beds & Mulch', active: true },
    softEdge: { labels: ['Soft Edge', 'Soft Edging'], pricebookItemId: 221, unit: 'ft', category: 'Edging', active: true },
    hardEdge: { labels: ['Hard Edge', 'Hard Edging'], pricebookItemId: 222, unit: 'ft', category: 'Edging', active: true },
    trimEdge: { labels: ['Trim Edge', 'Trim Edging'], pricebookItemId: 223, unit: 'ft', category: 'Edging', active: true },
    hedge: { labels: ['Hedge', 'Hedges'], pricebookItemId: 224, unit: 'ft', category: 'Shrubs & Trees', active: true },
    tree: { labels: ['Tree', 'Trees'], pricebookItemId: 225, unit: 'each', category: 'Shrubs & Trees', active: true },
    palmTree: { labels: ['Palm Tree', 'Palm Trees'], pricebookItemId: 226, unit: 'each', category: 'Shrubs & Trees', active: true },

    allSidewalks: { labels: ['All Sidewalks', 'Sidewalks'], pricebookItemId: 227, unit: 'sq ft', category: 'Hard Surfaces', active: true },
    privateSidewalks: { labels: ['Private Sidewalks', 'Private Sidewalk'], pricebookItemId: 228, unit: 'sq ft', category: 'Hard Surfaces', active: true },
    publicSidewalks: { labels: ['Public Sidewalks', 'Public Sidewalk'], pricebookItemId: 229, unit: 'sq ft', category: 'Hard Surfaces', active: true },

    parkingLots: { labels: ['Parking Lots', 'Parking Lot'], pricebookItemId: 230, unit: 'sq ft', category: 'Hard Surfaces', active: true },
    parkingSpaces: { labels: ['Parking Spaces', 'Parking Space'], pricebookItemId: 231, unit: 'sq ft', category: 'Hard Surfaces', active: true },
    parkingDriveLanes: { labels: ['Parking Drive Lanes', 'Parking Drive Lane'], pricebookItemId: 232, unit: 'sq ft', category: 'Hard Surfaces', active: true },

    pavements: { labels: ['Pavements', 'Pavement'], pricebookItemId: 233, unit: 'sq ft', category: 'Hard Surfaces', active: true },
    driveways: { labels: ['Driveways', 'Driveway'], pricebookItemId: 234, unit: 'sq ft', category: 'Hard Surfaces', active: true },
    concreteSurfaces: { labels: ['Concrete Surfaces', 'Concrete Surface'], pricebookItemId: 235, unit: 'sq ft', category: 'Hard Surfaces', active: true },
    asphaltSurfaces: { labels: ['Asphalt Surfaces', 'Asphalt Surface'], pricebookItemId: 236, unit: 'sq ft', category: 'Hard Surfaces', active: true },
    roadways: { labels: ['Roadways', 'Roadway'], pricebookItemId: 237, unit: 'sq ft', category: 'Hard Surfaces', active: true },

    buildingFootprint: { labels: ['Building Footprint', 'Roof', 'Roof Area'], pricebookItemId: 238, unit: 'sq ft', category: 'Roofing & Exterior', active: true },
    waterBody: { labels: ['Water Body', 'Water Bodies'], pricebookItemId: 239, unit: 'sq ft', category: 'Water Features', active: true },
    retentionPonds: { labels: ['Retention Ponds', 'Retention Pond'], pricebookItemId: 240, unit: 'sq ft', category: 'Water Features', active: true },

    docks: { labels: ['Docks', 'Dock'], referenceOnly: true, active: false },
    dockingPoint: { labels: ['Docking Point', 'Docking Points'], referenceOnly: true, active: false },
  },
  overlapRules: [
    {
      id: 'sidewalks_all_overrides_subtypes',
      ifPresent: 'allSidewalks',
      suppress: ['privateSidewalks', 'publicSidewalks'],
    },
    {
      id: 'parking_lots_overrides_subtypes',
      ifPresent: 'parkingLots',
      suppress: ['parkingSpaces', 'parkingDriveLanes'],
    },
  ],
  tierOrder: ['best', 'better', 'good'],
  tierRules: {
    best: { excludeCategories: [] },
    better: { excludeCategories: ['Roofing & Exterior', 'Water Features'] },
    good: { excludeCategories: ['Roofing & Exterior', 'Water Features', 'Beds & Mulch', 'Shrubs & Trees'] },
  },
  futurePhases: {
    frequencyEngine: { enabled: false, profiles: { best: {}, better: {}, good: {} } },
    seasonalBundles: { enabled: false },
  },
};

export function normalizeLayerLabel(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function buildLayerAliasMap(config = SITERECON_RULES) {
  const aliases = new Map();
  for (const [key, mapping] of Object.entries(config.layerMappings || {})) {
    for (const label of mapping.labels || []) {
      aliases.set(normalizeLayerLabel(label), key);
    }
  }
  return aliases;
}
