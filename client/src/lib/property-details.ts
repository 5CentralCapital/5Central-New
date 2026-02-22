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

  // Refinance Step
  refiLTV?: number;
  refiLoanAmount?: number;
  refiCashOut?: number;
  newMonthlyPI?: number;
  equityAfterRefi?: number;
  refiTargetMonth?: number;

  // Exit Step
  projectedSalePrice?: number;
  projectedNetProceeds?: number;
  projectedTotalProfit?: number;
  holdPeriodMonths?: number;
}

export const propertyDetails: Record<string, PropertyDetails> = {
  "Sun Cove Apartments": {
    location: "St. Petersburg, FL",
    yearBuilt: "Various",
    buildingSF: "TBD",
    closingDate: "Jan 2026",

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

    beforePhotos: [
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0838.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0839.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0840.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0841.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0842.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0843.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0845.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0846.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0847.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0848.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0849.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0850.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0851.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0852.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0853.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0854.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0855.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0856.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0857.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0858.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0859.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0860.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0861.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0862.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0863.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0864.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0865.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0866.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0867.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0868.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0869.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0870.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0871.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0872.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0873.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0874.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0875.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0876.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0877.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0878.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0879.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0880.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0881.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0882.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0883.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0884.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0885.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0886.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0887.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0888.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0889.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0890.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0891.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0892.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0893.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0894.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0895.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0896.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0897.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0898.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0899.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0900.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0901.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0902.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0903.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0904.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0905.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0906.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0907.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0908.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0909.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0910.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0911.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0912.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0913.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0914.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0915.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0916.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0917.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0918.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0919.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0920.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0921.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0922.jpeg",
      "/attached_assets/gallery/sun-cove-apartments/before/IMG_0923.jpeg",
    ],
    afterPhotos: [
      "/attached_assets/gallery/sun-cove-apartments/before/21 unit cover photo .jpg",
      "/attached_assets/gallery/sun-cove-apartments/before/13 unit cover photo.jpg",
      "/attached_assets/gallery/sun-cove-apartments/before/13 unit cover photo 1.jpg",
      "/attached_assets/gallery/sun-cove-apartments/before/13 unit cover photo 2.jpg",
      "/attached_assets/gallery/sun-cove-apartments/before/13 unit cover photo 3.jpg",
      "/attached_assets/gallery/sun-cove-apartments/before/13 unit cover photo 4.jpg",
      "/attached_assets/gallery/sun-cove-apartments/before/8 unit cover photo .jpg",
      "/attached_assets/gallery/sun-cove-apartments/before/8 unit cover photo 1.jpg",
    ],

    investmentThesis: "21-unit portfolio in St. Petersburg with significant value-add opportunity through renovation and rent increases. In-place rents significantly below market with 81% occupancy providing NOI upside of $163K through stabilization.",

    // Refinance Step
    refiLTV: 0.70,
    refiLoanAmount: 2940000,
    refiCashOut: 561095,
    newMonthlyPI: 15500,
    equityAfterRefi: 1260000,
    refiTargetMonth: 9,

    // Exit Step
    projectedSalePrice: 4200000,
    projectedNetProceeds: 1092000,
    projectedTotalProfit: 1331584,
    holdPeriodMonths: 24
  },

  "Lucia Apartments": {
    location: "Winter Haven, FL",
    yearBuilt: "1925",
    buildingSF: "10,620",
    closingDate: "Feb 2026",

    inPlaceNOI: 80520,
    stabilizedNOI: 157464,
    noiUpside: 76944,
    capRateInPlace: 0.061,
    capRateStabilized: 0.081,

    entryCapRate: 0.061,
    exitCapRate: 0.0526,
    capRateSpread: -0.0084,
    valueCreation: 827988,
    entryPerUnit: 82500,
    exitPerUnit: 173249,

    bridgeLoan: 993960,
    ltvPurchase: 0.753,
    ltc: 0.6917,
    interestRate: 0.1125,
    rehabHoldback: 350628,
    totalCommitment: 1344588,

    yieldOnCost: 0.081,
    arvPerUnit: 173249,
    arvTotal: 2771988,
    sponsorEquity: 599412,
    holdPeriod: "24 months",
    refiMonth: 6,

    irrLevered: "35-50%",
    moic: 2.15,
    cashYieldStabilized: 0.0297,
    paybackPeriod: 10.5,

    breakevenOccupancy: 0.293,
    dscrStabilized: 1.127,
    debtYield: 0.117,

    cashOutAtRefi: 480987,
    netCashFromSale: 807814,
    totalProfit: 689389,

    totalUnits: 16,
    occupiedUnits: 10,
    occupancyRate: 0.625,
    inPlaceRent: 11437,
    proformaRent: 19620,
    rentUpside: 8183,

    currentDebt: 1344588,
    monthlyPI: 11641,
    annualDebtService: 139692,
    maturityDate: "Feb 2028",
    loanType: "Bridge",

    beforePhotos: [
      "/attached_assets/gallery/lucia-apartments/before/IMG_1722.jpeg",
      "/attached_assets/gallery/lucia-apartments/before/IMG_1723.jpeg",
      "/attached_assets/gallery/lucia-apartments/before/IMG_1724.jpeg",
      "/attached_assets/gallery/lucia-apartments/before/IMG_1729.jpeg",
    ],
    afterPhotos: [],

    investmentThesis: "16-unit historic property in Winter Haven with proforma rents conservative vs renovated comps. Higher-end comps ($1,400-1,675 for 1BR) support significant rent upside after renovation.",

    refiLTV: 0.659,
    refiLoanAmount: 1825575,
    refiCashOut: 480987,
    newMonthlyPI: 9889,
    equityAfterRefi: 946413,
    refiTargetMonth: 6,

    projectedSalePrice: 2771988,
    projectedNetProceeds: 807814,
    projectedTotalProfit: 689389,
    holdPeriodMonths: 24
  },

  "Hickory Landing": {
    location: "Lakeland, FL",
    yearBuilt: "Various",
    buildingSF: "TBD",
    closingDate: "Sep 2025",

    inPlaceNOI: 24122,
    stabilizedNOI: 84163,
    noiUpside: 60041,
    capRateInPlace: 0.0363,
    capRateStabilized: 0.065,

    entryCapRate: 0.0363,
    exitCapRate: 0.065,
    capRateSpread: 0.0287,
    valueCreation: 479812,
    entryPerUnit: 83125,
    exitPerUnit: 161851,

    bridgeLoan: 532000,
    ltvPurchase: 0.80,
    ltc: 0.65,
    interestRate: 0.1125,
    rehabHoldback: 150000,
    totalCommitment: 682000,

    yieldOnCost: 0.1033,
    arvPerUnit: 161851,
    arvTotal: 1294812,
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

    cashOutAtRefi: 350000,
    netCashFromSale: 336000,
    totalProfit: 527028,

    totalUnits: 8,
    occupiedUnits: 4,
    occupancyRate: 0.50,
    inPlaceRent: 4975,
    proformaRent: 11300,
    rentUpside: 6325,

    currentDebt: 682000,
    monthlyPI: 6396,
    annualDebtService: 76752,
    maturityDate: "Q3 2027",
    loanType: "Bridge",

    beforePhotos: [
      "/attached_assets/gallery/hickory-landing/before/IMG_0015.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_0016.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_0017.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_0018.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_0079.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_0080.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_0081.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_0082.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_0083.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_0084.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_0085.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_0086.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_0087.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_0088.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_0089.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_0090.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_0091.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_0959.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_0960.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_0961.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_9283.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_9284.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_9285.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_9286.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_9287.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_9288.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_9289.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_9290.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_9291.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_9292.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_9293.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_9294.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_9295.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_9296.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_9297.jpeg",
      "/attached_assets/gallery/hickory-landing/before/IMG_9298.jpeg",
    ],
    afterPhotos: [],

    investmentThesis: "8-unit portfolio in Lakeland with massive NOI upside (249%) through renovation and lease-up. Currently 50% occupied with significant rent growth potential to $1,375-1,450/unit.",

    // Refinance Step
    refiLTV: 0.70,
    refiLoanAmount: 906368,
    refiCashOut: 350000,
    newMonthlyPI: 5700,
    equityAfterRefi: 388444,
    refiTargetMonth: 9,

    // Exit Step
    projectedSalePrice: 1294812,
    projectedNetProceeds: 336000,
    projectedTotalProfit: 527028,
    holdPeriodMonths: 24
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
    arvTotal: 1975000,
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

    beforePhotos: [
      "/attached_assets/gallery/mlk-apartments/before/IMG_1579.jpeg",
      "/attached_assets/gallery/mlk-apartments/before/IMG_1580.jpeg",
      "/attached_assets/gallery/mlk-apartments/before/IMG_1581.jpeg",
      "/attached_assets/gallery/mlk-apartments/before/IMG_1582.jpeg",
      "/attached_assets/gallery/mlk-apartments/before/IMG_1583.jpeg",
      "/attached_assets/gallery/mlk-apartments/before/IMG_1605.jpeg",
      "/attached_assets/gallery/mlk-apartments/before/IMG_1606.jpeg",
      "/attached_assets/gallery/mlk-apartments/before/IMG_1607.jpeg",
      "/attached_assets/gallery/mlk-apartments/before/IMG_1608.jpeg",
      "/attached_assets/gallery/mlk-apartments/before/IMG_1609.jpeg",
      "/attached_assets/gallery/mlk-apartments/before/IMG_1610.jpeg",
      "/attached_assets/gallery/mlk-apartments/before/IMG_1611.jpeg",
      "/attached_assets/gallery/mlk-apartments/before/IMG_1612.jpeg",
      "/attached_assets/gallery/mlk-apartments/before/IMG_7227.PNG",
      "/attached_assets/gallery/mlk-apartments/before/IMG_7228.PNG",
      "/attached_assets/gallery/mlk-apartments/before/IMG_7229.PNG",
      "/attached_assets/gallery/mlk-apartments/before/IMG_7230.PNG",
      "/attached_assets/gallery/mlk-apartments/before/IMG_7231.PNG",
      "/attached_assets/gallery/mlk-apartments/before/IMG_7435.jpeg",
      "/attached_assets/gallery/mlk-apartments/before/IMG_8063.jpeg",
      "/attached_assets/gallery/mlk-apartments/before/IMG_8064.jpeg",
      "/attached_assets/gallery/mlk-apartments/before/IMG_8065.jpeg",
      "/attached_assets/gallery/mlk-apartments/before/IMG_8066.jpeg",
      "/attached_assets/gallery/mlk-apartments/before/IMG_8104.jpeg",
      "/attached_assets/gallery/mlk-apartments/before/IMG_8105.jpeg",
      "/attached_assets/gallery/mlk-apartments/before/IMG_8106.jpeg",
      "/attached_assets/gallery/mlk-apartments/before/IMG_8107.jpeg",
      "/attached_assets/gallery/mlk-apartments/before/IMG_8110.jpeg",
      "/attached_assets/gallery/mlk-apartments/before/IMG_8110(1).jpeg",
      "/attached_assets/gallery/mlk-apartments/before/IMG_8111.jpeg",
      "/attached_assets/gallery/mlk-apartments/before/IMG_8111(1).jpeg",
      "/attached_assets/gallery/mlk-apartments/before/IMG_8112.jpeg",
      "/attached_assets/gallery/mlk-apartments/before/IMG_8112(1).jpeg",
      "/attached_assets/gallery/mlk-apartments/before/IMG_8224.jpeg",
    ],
    afterPhotos: [
      "/attached_assets/gallery/mlk-apartments/after/IMG_8035.jpeg",
      "/attached_assets/gallery/mlk-apartments/after/IMG_8036.jpeg",
      "/attached_assets/gallery/mlk-apartments/after/IMG_8037.jpeg",
      "/attached_assets/gallery/mlk-apartments/after/IMG_8038.jpeg",
      "/attached_assets/gallery/mlk-apartments/after/IMG_8039.jpeg",
      "/attached_assets/gallery/mlk-apartments/after/IMG_8040.jpeg",
      "/attached_assets/gallery/mlk-apartments/after/IMG_8041.jpeg",
      "/attached_assets/gallery/mlk-apartments/after/IMG_8042.jpeg",
      "/attached_assets/gallery/mlk-apartments/after/IMG_8043.jpeg",
      "/attached_assets/gallery/mlk-apartments/after/IMG_8044.jpeg",
      "/attached_assets/gallery/mlk-apartments/after/IMG_8045.jpeg",
      "/attached_assets/gallery/mlk-apartments/after/IMG_8046.jpeg",
      "/attached_assets/gallery/mlk-apartments/after/IMG_8074.jpeg",
      "/attached_assets/gallery/mlk-apartments/after/IMG_8075.jpeg",
      "/attached_assets/gallery/mlk-apartments/after/IMG_8076.jpeg",
      "/attached_assets/gallery/mlk-apartments/after/IMG_8077.jpeg",
      "/attached_assets/gallery/mlk-apartments/after/IMG_8078.jpeg",
      "/attached_assets/gallery/mlk-apartments/after/IMG_8079.jpeg",
      "/attached_assets/gallery/mlk-apartments/after/IMG_8080.jpeg",
      "/attached_assets/gallery/mlk-apartments/after/IMG_8081.jpeg",
      "/attached_assets/gallery/mlk-apartments/after/IMG_8330.jpeg",
      "/attached_assets/gallery/mlk-apartments/after/IMG_8331.jpeg",
      "/attached_assets/gallery/mlk-apartments/after/IMG_8332.jpeg",
      "/attached_assets/gallery/mlk-apartments/after/IMG_8336.jpeg",
      "/attached_assets/gallery/mlk-apartments/after/IMG_8337.jpeg",
      "/attached_assets/gallery/mlk-apartments/after/IMG_8338.jpeg",
      "/attached_assets/gallery/mlk-apartments/after/IMG_8339.jpeg",
      "/attached_assets/gallery/mlk-apartments/after/IMG_8340.jpeg",
      "/attached_assets/gallery/mlk-apartments/after/IMG_8341.jpeg",
    ],

    investmentThesis: "10-unit stabilized property in Tampa at 100% occupancy. Strong DSCR of 1.81x and debt yield of 10.4%. Major rehab completed with $450K investment creating $700K in value.",

    // Refinance Step
    refiLTV: 0.70,
    refiLoanAmount: 1330000,
    refiCashOut: 160300,
    newMonthlyPI: 8300,
    equityAfterRefi: 570000,
    refiTargetMonth: 9,

    // Exit Step
    projectedSalePrice: 1900000,
    projectedNetProceeds: 589000,
    projectedTotalProfit: 527175,
    holdPeriodMonths: 24
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
