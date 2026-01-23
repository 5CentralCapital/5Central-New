// Detailed property data extracted from Excel files for modal display

export interface PropertyDetails {
  // Deal Overview
  location: string;
  yearBuilt: string;
  buildingSF: string;
  closingDate: string;

  // Acquisition Metrics
  inPlaceNOI: number;
  stabilizedNOI: number;
  noiUpside: number;
  capRateInPlace: number;
  capRateStabilized: number;

  // Valuation Analysis
  entryCapRate: number;
  exitCapRate: number;
  capRateSpread: number;
  valueCreation: number;
  entryPerUnit: number;
  exitPerUnit: number;

  // Financing Summary
  bridgeLoan: number;
  ltvPurchase: number;
  ltc: number;
  interestRate: number;
  rehabHoldback: number;
  totalCommitment: number;

  // Key Returns
  yieldOnCost: number;
  arvPerUnit: number;
  arvTotal: number;
  sponsorEquity: number;
  holdPeriod: string;
  refiMonth: number;

  // Return Analysis
  irrLevered: string;
  moic: number;
  cashYieldStabilized: number;
  paybackPeriod: number;

  // Risk Metrics
  breakevenOccupancy: number;
  dscrStabilized: number;
  debtYield: number;

  // Exit Analysis
  cashOutAtRefi: number;
  netCashFromSale: number;
  totalProfit: number;

  // Rent Roll Summary
  totalUnits: number;
  occupiedUnits: number;
  occupancyRate: number;
  inPlaceRent: number;
  proformaRent: number;
  rentUpside: number;

  // Debt Details
  currentDebt: number;
  monthlyPI: number;
  annualDebtService: number;
  maturityDate: string;
  loanType: string;

  // Photos
  beforePhotos?: string[];
  afterPhotos?: string[];

  // Investment Thesis
  investmentThesis?: string;
}

export const propertyDetails: Record<string, PropertyDetails> = {
  "Sun Cove Apartments": {
    location: "St. Petersburg, FL",
    yearBuilt: "Various",
    buildingSF: "TBD",
    closingDate: "Jan 2024",

    inPlaceNOI: 100164,
    stabilizedNOI: 263861,
    noiUpside: 163697,
    capRateInPlace: 0.0501,
    capRateStabilized: 0.1319,

    entryCapRate: 0.0501,
    exitCapRate: 0.0628,
    capRateSpread: 0.0127,
    valueCreation: 1697895,
    entryPerUnit: 95238,
    exitPerUnit: 200000,

    bridgeLoan: 1600000,
    ltvPurchase: 0.80,
    ltc: 0.84,
    interestRate: 0.1125,
    rehabHoldback: 502105,
    totalCommitment: 2102105,

    yieldOnCost: 0.1055,
    arvPerUnit: 200000,
    arvTotal: 4200000,
    sponsorEquity: 321511,
    holdPeriod: "24 months",
    refiMonth: 9,

    irrLevered: "40-50%",
    moic: 5.14,
    cashYieldStabilized: 0.821,
    paybackPeriod: 14.6,

    breakevenOccupancy: 0.30,
    dscrStabilized: 1.56,
    debtYield: 0.090,

    cashOutAtRefi: 561095,
    netCashFromSale: 1092000,
    totalProfit: 1331584,

    totalUnits: 21,
    occupiedUnits: 17,
    occupancyRate: 0.81,
    inPlaceRent: 16750,
    proformaRent: 32000,
    rentUpside: 15250,

    currentDebt: 2102105,
    monthlyPI: 19707,
    annualDebtService: 236484,
    maturityDate: "Q4 2026",
    loanType: "Bridge",

    beforePhotos: [], // Coming soon
    afterPhotos: [
      "/attached_assets/gallery/sun-cove-21-unit-cover-photo-.jpg",
      "/attached_assets/gallery/sun-cove-13-unit-cover-photo.jpg",
      "/attached_assets/gallery/sun-cove-13-unit-cover-photo-1.jpg",
      "/attached_assets/gallery/sun-cove-13-unit-cover-photo-2.jpg",
      "/attached_assets/gallery/sun-cove-8-unit-cover-photo-.jpg",
      "/attached_assets/gallery/sun-cove-8-unit-cover-photo-1.jpg",
    ],

    investmentThesis: "21-unit portfolio in St. Petersburg with significant value-add opportunity through renovation and rent increases. In-place rents significantly below market with 81% occupancy providing NOI upside of $163K through stabilization."
  },

  "Lucia Apartments": {
    location: "Winter Haven, FL",
    yearBuilt: "1925",
    buildingSF: "10,620",
    closingDate: "Feb 2024",

    inPlaceNOI: 89066,
    stabilizedNOI: 140853,
    noiUpside: 51787,
    capRateInPlace: 0.0675,
    capRateStabilized: 0.1067,

    entryCapRate: 0.0675,
    exitCapRate: 0.0534,
    capRateSpread: -0.0141,
    valueCreation: 970000,
    entryPerUnit: 82500,
    exitPerUnit: 165000,

    bridgeLoan: 1056000,
    ltvPurchase: 0.80,
    ltc: 0.84,
    interestRate: 0.1125,
    rehabHoldback: 350000,
    totalCommitment: 1406000,

    yieldOnCost: 0.0843,
    arvPerUnit: 165000,
    arvTotal: 2640000,
    sponsorEquity: 123230,
    holdPeriod: "24 months",
    refiMonth: 6,

    irrLevered: "35-45%",
    moic: 8.64,
    cashYieldStabilized: 1.14,
    paybackPeriod: 10.5,

    breakevenOccupancy: 0.37,
    dscrStabilized: 1.09,
    debtYield: 0.076,

    cashOutAtRefi: 405040,
    netCashFromSale: 660000,
    totalProfit: 941810,

    totalUnits: 16,
    occupiedUnits: 10,
    occupancyRate: 0.625,
    inPlaceRent: 11695,
    proformaRent: 22350,
    rentUpside: 10655,

    currentDebt: 1406000,
    monthlyPI: 13181,
    annualDebtService: 158172,
    maturityDate: "Q1 2026",
    loanType: "Bridge",

    beforePhotos: [], // Coming soon
    afterPhotos: [
      "/attached_assets/gallery/lucia-1.jpg",
      "/attached_assets/gallery/lucia-2.jpg",
      "/attached_assets/gallery/lucia-3.jpg",
      "/attached_assets/gallery/lucia-4.jpg",
      "/attached_assets/gallery/lucia-5.jpg",
    ],

    investmentThesis: "16-unit historic property in Winter Haven with proforma rents conservative vs renovated comps. Higher-end comps ($1,400-1,675 for 1BR) support significant rent upside after renovation."
  },

  "Hickory Landing": {
    location: "Lakeland, FL",
    yearBuilt: "Various",
    buildingSF: "TBD",
    closingDate: "Mar 2024",

    inPlaceNOI: 24122,
    stabilizedNOI: 84163,
    noiUpside: 60041,
    capRateInPlace: 0.0363,
    capRateStabilized: 0.1266,

    entryCapRate: 0.0363,
    exitCapRate: 0.0526,
    capRateSpread: 0.0163,
    valueCreation: 785000,
    entryPerUnit: 83125,
    exitPerUnit: 200000,

    bridgeLoan: 532000,
    ltvPurchase: 0.80,
    ltc: 0.84,
    interestRate: 0.1125,
    rehabHoldback: 150000,
    totalCommitment: 682000,

    yieldOnCost: 0.1033,
    arvPerUnit: 200000,
    arvTotal: 1600000,
    sponsorEquity: 159373,
    holdPeriod: "24 months",
    refiMonth: 9,

    irrLevered: "40-50%",
    moic: 5.22,
    cashYieldStabilized: 0.528,
    paybackPeriod: 22.7,

    breakevenOccupancy: 0.34,
    dscrStabilized: 1.31,
    debtYield: 0.075,

    cashOutAtRefi: 415600,
    netCashFromSale: 416000,
    totalProfit: 672228,

    totalUnits: 8,
    occupiedUnits: 4,
    occupancyRate: 0.50,
    inPlaceRent: 4975,
    proformaRent: 11300,
    rentUpside: 6325,

    currentDebt: 682000,
    monthlyPI: 6396,
    annualDebtService: 76752,
    maturityDate: "Q2 2026",
    loanType: "Bridge",

    investmentThesis: "8-unit portfolio in Lakeland with massive NOI upside (249%) through renovation and lease-up. Currently 50% occupied with significant rent growth potential to $1,375-1,450/unit."
  },

  "MLK Apartments": {
    location: "Tampa, FL",
    yearBuilt: "Various",
    buildingSF: "TBD",
    closingDate: "Nov 2024",

    inPlaceNOI: 126612,
    stabilizedNOI: 128580,
    noiUpside: 1968,
    capRateInPlace: 0.1688,
    capRateStabilized: 0.1714,

    entryCapRate: 0.1688,
    exitCapRate: 0.0677,
    capRateSpread: -0.1011,
    valueCreation: 700000,
    entryPerUnit: 75000,
    exitPerUnit: 190000,

    bridgeLoan: 600000,
    ltvPurchase: 0.80,
    ltc: 0.875,
    interestRate: 0.1125,
    rehabHoldback: 450000,
    totalCommitment: 1050000,

    yieldOnCost: 0.1072,
    arvPerUnit: 190000,
    arvTotal: 1900000,
    sponsorEquity: 222125,
    holdPeriod: "24 months",
    refiMonth: 9,

    irrLevered: "40-50%",
    moic: 3.37,
    cashYieldStabilized: 0.579,
    paybackPeriod: 20.7,

    breakevenOccupancy: 0.43,
    dscrStabilized: 1.81,
    debtYield: 0.104,

    cashOutAtRefi: 160300,
    netCashFromSale: 589000,
    totalProfit: 527175,

    totalUnits: 10,
    occupiedUnits: 10,
    occupancyRate: 1.0,
    inPlaceRent: 16850,
    proformaRent: 17050,
    rentUpside: 200,

    currentDebt: 1235000,
    monthlyPI: 6432,
    annualDebtService: 77184,
    maturityDate: "Q1 2026",
    loanType: "Bridge",

    investmentThesis: "10-unit stabilized property in Tampa at 100% occupancy. Strong DSCR of 1.81x and debt yield of 10.4%. Major rehab completed with $450K investment creating $700K in value."
  }
};

// Sold property details (simpler structure)
export interface SoldPropertyDetails {
  initialCapitalRequired: number;
  totalCashflowCollected: number;
  saleProceeds: number;
  totalProfit: number;
  cashOnCash: number;
  totalReturnPercent: number;
  appreciationPercent: number;
  pricePerUnit: number;
  totalBasis: number;
  grossProfit: number;
  roc: number;
  avgAnnualReturn: number;
  profitPerUnit: number;
}

export const soldPropertyDetails: Record<string, SoldPropertyDetails> = {
  "1 Harmony St": {
    initialCapitalRequired: 150000,
    totalCashflowCollected: 0,
    saleProceeds: 162500,
    totalProfit: 12500,
    cashOnCash: 0,
    totalReturnPercent: 8.33,
    appreciationPercent: 12.11,
    pricePerUnit: 312500,
    totalBasis: 1115000,
    grossProfit: 135000,
    roc: 12.11,
    avgAnnualReturn: 6.67,
    profitPerUnit: 3125
  },
  "41 Stuart Ave": {
    initialCapitalRequired: 20000,
    totalCashflowCollected: 144000,
    saleProceeds: 159000,
    totalProfit: 283000,
    cashOnCash: 180,
    totalReturnPercent: 1415,
    appreciationPercent: 69.77,
    pricePerUnit: 121667,
    totalBasis: 215000,
    grossProfit: 150000,
    roc: 69.77,
    avgAnnualReturn: 353.75,
    profitPerUnit: 94333
  },
  "52 Summit Ave": {
    initialCapitalRequired: 30000,
    totalCashflowCollected: 48000,
    saleProceeds: 75000,
    totalProfit: 93000,
    cashOnCash: 64,
    totalReturnPercent: 310,
    appreciationPercent: 15.38,
    pricePerUnit: 187500,
    totalBasis: 325000,
    grossProfit: 50000,
    roc: 15.38,
    avgAnnualReturn: 124,
    profitPerUnit: 46500
  },
  "29 Brainard St": {
    initialCapitalRequired: 12000,
    totalCashflowCollected: 30000,
    saleProceeds: 55000,
    totalProfit: 73000,
    cashOnCash: 83.33,
    totalReturnPercent: 608.33,
    appreciationPercent: 13.98,
    pricePerUnit: 375000,
    totalBasis: 329000,
    grossProfit: 46000,
    roc: 13.98,
    avgAnnualReturn: 202.78,
    profitPerUnit: 73000
  },
  "25 Huntington Pl": {
    initialCapitalRequired: 100000,
    totalCashflowCollected: 36000,
    saleProceeds: 84000,
    totalProfit: 20000,
    cashOnCash: 18,
    totalReturnPercent: 20,
    appreciationPercent: 9.72,
    pricePerUnit: 350000,
    totalBasis: 319000,
    grossProfit: 31000,
    roc: 9.72,
    avgAnnualReturn: 10,
    profitPerUnit: 20000
  },
  "175 Crystal Ave": {
    initialCapitalRequired: 25000,
    totalCashflowCollected: 97000,
    saleProceeds: 110000,
    totalProfit: 182000,
    cashOnCash: 194,
    totalReturnPercent: 728,
    appreciationPercent: 51.79,
    pricePerUnit: 212500,
    totalBasis: 280000,
    grossProfit: 145000,
    roc: 51.79,
    avgAnnualReturn: 364,
    profitPerUnit: 91000
  },
  "35 Linden St": {
    initialCapitalRequired: 112500,
    totalCashflowCollected: 84000,
    saleProceeds: 122500,
    totalProfit: 94000,
    cashOnCash: 37.33,
    totalReturnPercent: 83.56,
    appreciationPercent: 14.29,
    pricePerUnit: 146667,
    totalBasis: 385000,
    grossProfit: 55000,
    roc: 14.29,
    avgAnnualReturn: 41.78,
    profitPerUnit: 31333
  },
  "145 Crystal Ave": {
    initialCapitalRequired: 108500,
    totalCashflowCollected: 90000,
    saleProceeds: 80000,
    totalProfit: 61500,
    cashOnCash: 41.47,
    totalReturnPercent: 56.68,
    appreciationPercent: 25,
    pricePerUnit: 108333,
    totalBasis: 260000,
    grossProfit: 65000,
    roc: 25,
    avgAnnualReturn: 28.34,
    profitPerUnit: 20500
  },
  "149 Crystal Ave": {
    initialCapitalRequired: 115000,
    totalCashflowCollected: 90000,
    saleProceeds: 80000,
    totalProfit: 55000,
    cashOnCash: 39.13,
    totalReturnPercent: 47.83,
    appreciationPercent: 16.07,
    pricePerUnit: 108333,
    totalBasis: 280000,
    grossProfit: 45000,
    roc: 16.07,
    avgAnnualReturn: 23.91,
    profitPerUnit: 18333
  },
  "157 Crystal Ave": {
    initialCapitalRequired: 100000,
    totalCashflowCollected: 87000,
    saleProceeds: 227800,
    totalProfit: 214800,
    cashOnCash: 34.8,
    totalReturnPercent: 214.8,
    appreciationPercent: 70.98,
    pricePerUnit: 132000,
    totalBasis: 386000,
    grossProfit: 274000,
    roc: 70.98,
    avgAnnualReturn: 85.92,
    profitPerUnit: 42960
  }
};

export const getPropertyDetails = (propertyName: string): PropertyDetails | undefined => {
  return propertyDetails[propertyName];
};

export const getSoldPropertyDetails = (propertyName: string): SoldPropertyDetails | undefined => {
  return soldPropertyDetails[propertyName];
};
