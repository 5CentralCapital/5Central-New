export type FlipStatus = "active-rehab" | "acquisition-under-contract" | "sold";

export type FlipPhotoStage = "before" | "current" | "design" | "after";

export interface FlipPhoto {
  src: string;
  alt: string;
  caption: string;
  stage: FlipPhotoStage;
}

export interface FlipMilestone {
  label: string;
  date: string;
  state: "complete" | "current" | "upcoming";
}

export interface FlipProject {
  slug: string;
  name: string;
  location: string;
  status: FlipStatus;
  statusLabel: string;
  thesis: string;
  statusNote: string;
  purchasePrice: number;
  acquisitionCharges: number;
  acquisitionCredits: number;
  netAcquisitionCosts: number;
  projectLoanOrPayoff: number;
  cashThroughClose: number;
  modeledEquityCapital: number;
  rehabForecast: number;
  rehabLogged: number;
  rehabRemaining: number;
  rehabLoanOrDraws: number;
  netRehabCash: number;
  carryAndInterest: number;
  exitFee: number;
  projectedSale: number;
  sellingCosts: number;
  priorSellingCosts: number;
  sellingCostSavings: number;
  netSaleCashAfterDebt: number;
  projectProfit: number;
  projectProfitPriorCase: number;
  roiOnModeledEquity: number;
  milestones: FlipMilestone[];
  photos: FlipPhoto[];
}

export const flipsSource = {
  workbook: "2026-08-29_Current_Flips_Unified.xlsx",
  workbookSavedAt: "September 1, 2026",
  statusAsOf: "September 2, 2026",
  sellingCostRate: 0.035,
  priorSellingCostRate: 0.075,
};

export const flipPortfolioSummary = {
  projectCount: 3,
  activeRehabs: 2,
  acquisitionsUnderContract: 1,
  projectedSaleValue: 1_575_000,
  projectedProjectProfit: 246_571.3080604534,
  projectedSellingCostSavings: 63_000,
  modeledEquityCapital: 226_131.5519395466,
  netSaleCashAfterDebt: 472_702.86,
};

function progressPhoto(
  folder: string,
  fileNumber: number,
  propertyName: string,
  description: string,
): FlipPhoto {
  return {
    src: `/attached_assets/flips/${folder}/progress-${fileNumber}.jpg`,
    alt: `Current renovation progress showing ${description} at ${propertyName}`,
    caption: `Current progress — ${description}.`,
    stage: "current",
  };
}

const imageNumberRange = (start: number, end: number) =>
  Array.from({ length: end - start + 1 }, (_, index) => `img-${start + index}`);

const comancheBeforePhotoIds = [
  "2",
  "3",
  "4",
  ...imageNumberRange(6903, 6962),
  ...imageNumberRange(6966, 6970),
  ...imageNumberRange(6972, 6996),
];

const comancheBeforePhotos: FlipPhoto[] = comancheBeforePhotoIds.map((fileId, index, photos) => ({
  src: `/attached_assets/flips/328-comanche/before-${fileId}.jpg`,
  alt: `Pre-purchase condition at 328 W Comanche Avenue, inspection photo ${index + 1} of ${photos.length}`,
  caption: `Pre-purchase condition — inspection photo ${index + 1} of ${photos.length}.`,
  stage: "before",
}));

// Financial values below are a presentation snapshot of the verified unified workbook.
// Operational status is kept separate because workbook projections are not completion evidence.
export const currentFlips: FlipProject[] = [
  {
    slug: "11169-115th-street",
    name: "11169 115th Street",
    location: "Pinellas County, Florida",
    status: "active-rehab",
    statusLabel: "Active rehab",
    thesis: "Reposition the single-family home, including the planned sunroom extension, for a modeled $550K exit.",
    statusNote: "Rehab is in progress. Logged spend is a budget-control measure, not a physical completion certificate.",
    purchasePrice: 345_000,
    acquisitionCharges: 10_820,
    acquisitionCredits: 10_000,
    netAcquisitionCosts: 820,
    projectLoanOrPayoff: 402_500,
    cashThroughClose: 9_761.4,
    modeledEquityCapital: 94_836.77,
    rehabForecast: 109_296.79,
    rehabLogged: 63_446.74,
    rehabRemaining: 45_850.05,
    rehabLoanOrDraws: 60_000,
    netRehabCash: 49_296.79,
    carryAndInterest: 42_219.98,
    exitFee: 5_031.25,
    projectedSale: 550_000,
    sellingCosts: 19_250,
    priorSellingCosts: 41_250,
    sellingCostSavings: 22_000,
    netSaleCashAfterDebt: 123_218.75,
    projectProfit: 28_381.98,
    projectProfitPriorCase: 6_381.98,
    roiOnModeledEquity: 0.2992718963,
    milestones: [
      { label: "Purchased", date: "Mar 10, 2026", state: "complete" },
      { label: "List target", date: "Sep 11, 2026", state: "upcoming" },
      { label: "Rehab target", date: "Sep 18, 2026", state: "current" },
      { label: "Resale contract target", date: "Oct 30, 2026", state: "upcoming" },
      { label: "Sale close target", date: "Dec 7, 2026", state: "upcoming" },
    ],
    photos: [
      progressPhoto("11169-115th", 4097, "11169 115th Street", "kitchen island and cabinetry"),
      progressPhoto("11169-115th", 4098, "11169 115th Street", "cabinetry and appliance wall"),
      progressPhoto("11169-115th", 4099, "11169 115th Street", "kitchen island and open living area"),
      progressPhoto("11169-115th", 4100, "11169 115th Street", "finished kitchen cabinetry"),
      progressPhoto("11169-115th", 4101, "11169 115th Street", "kitchen counter and storage installation"),
      progressPhoto("11169-115th", 4102, "11169 115th Street", "arched kitchen entry and pantry cabinetry"),
      progressPhoto("11169-115th", 4103, "11169 115th Street", "sunroom flooring and wall finish"),
      progressPhoto("11169-115th", 4104, "11169 115th Street", "sunroom wall finish and window"),
      progressPhoto("11169-115th", 4105, "11169 115th Street", "sunroom window and floor finish"),
      progressPhoto("11169-115th", 4106, "11169 115th Street", "hallway finishes and interior doors"),
      progressPhoto("11169-115th", 4107, "11169 115th Street", "hallway flooring and trim"),
      progressPhoto("11169-115th", 4108, "11169 115th Street", "bedroom flooring and finished interior doors"),
      progressPhoto("11169-115th", 4109, "11169 115th Street", "walk-in shower and bathroom fixtures"),
      progressPhoto("11169-115th", 4110, "11169 115th Street", "primary bathroom shower and toilet"),
      progressPhoto("11169-115th", 4111, "11169 115th Street", "marble-look shower surround and black fixtures"),
      progressPhoto("11169-115th", 4112, "11169 115th Street", "bathroom vanity and walk-in shower"),
      progressPhoto("11169-115th", 4113, "11169 115th Street", "utility room flooring and wall finish"),
      progressPhoto("11169-115th", 4114, "11169 115th Street", "utility area equipment and hookups"),
      progressPhoto("11169-115th", 4115, "11169 115th Street", "bedroom flooring and wall finish"),
      progressPhoto("11169-115th", 4116, "11169 115th Street", "kitchen entry and flooring transition"),
      progressPhoto("11169-115th", 4117, "11169 115th Street", "open living and kitchen layout"),
      progressPhoto("11169-115th", 4118, "11169 115th Street", "living room flooring and ceiling fixtures"),
      progressPhoto("11169-115th", 4119, "11169 115th Street", "kitchen island installation"),
      progressPhoto("11169-115th", 4120, "11169 115th Street", "hallway closet and bathroom access"),
      progressPhoto("11169-115th", 4121, "11169 115th Street", "hallway flooring and bathroom access"),
      progressPhoto("11169-115th", 4122, "11169 115th Street", "bathroom vanity and illuminated mirror"),
      progressPhoto("11169-115th", 4123, "11169 115th Street", "bathroom vanity and fixture installation"),
      progressPhoto("11169-115th", 4124, "11169 115th Street", "tub surround tile and plumbing fixtures"),
      progressPhoto("11169-115th", 4125, "11169 115th Street", "secondary bathroom finish package"),
      progressPhoto("11169-115th", 4126, "11169 115th Street", "bedroom flooring and window trim"),
      progressPhoto("11169-115th", 4127, "11169 115th Street", "living area flooring and ceiling fan"),
      progressPhoto("11169-115th", 4128, "11169 115th Street", "living area finish work"),
      progressPhoto("11169-115th", 4129, "11169 115th Street", "bedroom flooring and fan installation"),
      progressPhoto("11169-115th", 4130, "11169 115th Street", "bedroom closet and floor finish"),
      progressPhoto("11169-115th", 4131, "11169 115th Street", "bedroom flooring and closet openings"),
      progressPhoto("11169-115th", 4132, "11169 115th Street", "completed hallway flooring and lighting"),
      {
        src: "/attached_assets/flips/11169-115th/exterior-concept.jpg",
        alt: "Concept rendering of the planned exterior and sunroom extension at 11169 115th Street",
        caption: "Exterior and sunroom extension concept — design direction, not a completed after photo.",
        stage: "design",
      },
      {
        src: "/attached_assets/flips/11169-115th/interior-concept.jpg",
        alt: "Concept rendering of the planned family room at 11169 115th Street",
        caption: "Family room concept — design direction, not a completed after photo.",
        stage: "design",
      },
    ],
  },
  {
    slug: "2217-mallory-avenue",
    name: "2217 Mallory Avenue",
    location: "Tampa, Florida",
    status: "active-rehab",
    statusLabel: "Active rehab",
    thesis: "Open the dated interior, rebuild the kitchen and baths, and bring a clean design plan to a modeled $325K exit.",
    statusNote: "Demolition and layout work are underway. Current photos are separated from design concepts and future after photos.",
    purchasePrice: 170_000,
    acquisitionCharges: 14_449.5,
    acquisitionCredits: 0,
    netAcquisitionCosts: 14_449.5,
    projectLoanOrPayoff: 188_640.89,
    cashThroughClose: 37_025.4,
    modeledEquityCapital: 44_434.07,
    rehabForecast: 40_140.89,
    rehabLogged: 14_283.34,
    rehabRemaining: 25_857.55,
    rehabLoanOrDraws: 40_140.89,
    netRehabCash: 0,
    carryAndInterest: 8_484.57,
    exitFee: 0,
    projectedSale: 325_000,
    sellingCosts: 11_375,
    priorSellingCosts: 24_375,
    sellingCostSavings: 13_000,
    netSaleCashAfterDebt: 124_984.11,
    projectProfit: 80_550.04,
    projectProfitPriorCase: 67_550.04,
    roiOnModeledEquity: 1.812799,
    milestones: [
      { label: "Purchased", date: "Aug 18, 2026", state: "complete" },
      { label: "List target", date: "Sep 15, 2026", state: "upcoming" },
      { label: "Rehab target", date: "Sep 22, 2026", state: "current" },
      { label: "Resale contract target", date: "Nov 5, 2026", state: "upcoming" },
      { label: "Sale close target", date: "Dec 14, 2026", state: "upcoming" },
    ],
    photos: [
      {
        src: "/attached_assets/flips/2217-mallory/before-exterior.jpg",
        alt: "Exterior of 2217 Mallory Avenue before renovation",
        caption: "Acquisition condition — front exterior.",
        stage: "before",
      },
      {
        src: "/attached_assets/flips/2217-mallory/before-kitchen.jpg",
        alt: "Kitchen at 2217 Mallory Avenue before renovation",
        caption: "Acquisition condition — original kitchen.",
        stage: "before",
      },
      {
        src: "/attached_assets/flips/2217-mallory/before-living.jpg",
        alt: "Living area at 2217 Mallory Avenue before renovation",
        caption: "Acquisition condition — original living area.",
        stage: "before",
      },
      progressPhoto("2217-mallory", 5160, "2217 Mallory Avenue", "existing living-area walls and built-ins"),
      progressPhoto("2217-mallory", 5161, "2217 Mallory Avenue", "ceiling and fan condition"),
      progressPhoto("2217-mallory", 5162, "2217 Mallory Avenue", "existing tile-floor condition"),
      progressPhoto("2217-mallory", 5163, "2217 Mallory Avenue", "original kitchen condition"),
      progressPhoto("2217-mallory", 5164, "2217 Mallory Avenue", "original bathroom condition"),
      progressPhoto("2217-mallory", 5165, "2217 Mallory Avenue", "bedroom floor and doorway condition"),
      progressPhoto("2217-mallory", 5166, "2217 Mallory Avenue", "hallway and room configuration"),
      progressPhoto("2217-mallory", 5167, "2217 Mallory Avenue", "existing interior layout"),
      progressPhoto("2217-mallory", 5179, "2217 Mallory Avenue", "living-area condition before demolition"),
      progressPhoto("2217-mallory", 5186, "2217 Mallory Avenue", "kitchen demolition underway"),
      progressPhoto("2217-mallory", 5219, "2217 Mallory Avenue", "room flooring removed"),
      progressPhoto("2217-mallory", 5220, "2217 Mallory Avenue", "floor preparation"),
      progressPhoto("2217-mallory", 5221, "2217 Mallory Avenue", "opened kitchen and structural framing"),
      progressPhoto("2217-mallory", 5222, "2217 Mallory Avenue", "kitchen demolition and framing"),
      progressPhoto("2217-mallory", 5255, "2217 Mallory Avenue", "drywall installation in the opened layout"),
      progressPhoto("2217-mallory", 5288, "2217 Mallory Avenue", "drywall finishing at the kitchen opening"),
      progressPhoto("2217-mallory", 5289, "2217 Mallory Avenue", "drywall finishing through the living area"),
      progressPhoto("2217-mallory", 5290, "2217 Mallory Avenue", "bathroom wall and fixture work"),
      progressPhoto("2217-mallory", 5291, "2217 Mallory Avenue", "bathroom plumbing and wallboard installation"),
      progressPhoto("2217-mallory", 5340, "2217 Mallory Avenue", "shower tile installation"),
      {
        src: "/attached_assets/flips/2217-mallory/kitchen-design.jpg",
        alt: "Kitchen design concept for 2217 Mallory Avenue",
        caption: "Kitchen concept — design direction, not a completed after photo.",
        stage: "design",
      },
    ],
  },
  {
    slug: "328-west-comanche-avenue",
    name: "328 W Comanche Avenue",
    location: "Tampa, Florida",
    status: "acquisition-under-contract",
    statusLabel: "Acquisition under contract",
    thesis: "Acquire at $440K, execute a $55K rehab plan, and underwrite to a modeled $700K resale.",
    statusNote: "The acquisition is under contract. No rehab spend is recorded before purchase close; the gallery documents pre-purchase condition only.",
    purchasePrice: 440_000,
    acquisitionCharges: 22_996.3419395466,
    acquisitionCredits: 0,
    netAcquisitionCosts: 22_996.3419395466,
    projectLoanOrPayoff: 451_000,
    cashThroughClose: 69_794.447419,
    modeledEquityCapital: 86_860.7119395466,
    rehabForecast: 55_000,
    rehabLogged: 0,
    rehabRemaining: 55_000,
    rehabLoanOrDraws: 55_000,
    netRehabCash: 0,
    carryAndInterest: 19_864.37,
    exitFee: 0,
    projectedSale: 700_000,
    sellingCosts: 24_500,
    priorSellingCosts: 52_500,
    sellingCostSavings: 28_000,
    netSaleCashAfterDebt: 224_500,
    projectProfit: 137_639.2880604534,
    projectProfitPriorCase: 109_639.2880604534,
    roiOnModeledEquity: 1.5845977,
    milestones: [
      { label: "Purchase close target", date: "Sep 18, 2026", state: "current" },
      { label: "List target", date: "Oct 11, 2026", state: "upcoming" },
      { label: "Rehab target", date: "Oct 18, 2026", state: "upcoming" },
      { label: "Resale contract target", date: "Nov 29, 2026", state: "upcoming" },
      { label: "Sale close target", date: "Jan 13, 2027", state: "upcoming" },
    ],
    photos: [
      ...comancheBeforePhotos,
      {
        src: "/attached_assets/flips/328-comanche/before-floor-plan.jpg",
        alt: "Pre-purchase floor plan for 328 W Comanche Avenue",
        caption: "Pre-purchase documentation — supplied floor plan showing the carport, kitchen, living room, lower family room, three bedrooms, and bathrooms.",
        stage: "before",
      },
    ],
  },
];

export const soldFlips: FlipProject[] = [];
