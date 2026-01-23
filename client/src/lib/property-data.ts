import sunCoveImg from "@assets/sun-cove-apartments.jpg";
import luciaImg from "@assets/lucia-apartments.jpg";
import hickoryImg from "@assets/hickory-landing.png";
import mlkImg from "@assets/mlk-apartments.jpg";

export const propertyImages: Record<string, string> = {
  // Current properties
  "Sun Cove Apartments": sunCoveImg,
  "Lucia Apartments": luciaImg,
  "Hickory Landing": hickoryImg,
  "MLK Apartments": mlkImg,
  // Sold properties (CT)
  "1 Harmony St": "/attached_assets/1 Harmony St _1754934705755.jpg",
  "41 Stuart Ave": "/attached_assets/41 stuart Ave_1754934705755.PNG",
  "52 Summit Ave": "/attached_assets/52 Summit ave_1754934705755.PNG",
  "29 Brainard St": "/attached_assets/29 Brainard St_1754934705755.PNG",
  "25 Huntington Pl": "/attached_assets/25 Huntington Pl_1754934705755.PNG",
  "175 Crystal Ave": "/attached_assets/175-crystal-ave.jpg",
  "35 Linden St": "/attached_assets/35 Linden St_1754934705755.PNG",
  "145 Crystal Ave": "/attached_assets/145 Crystal Ave_1754934705754.JPG",
  "149 Crystal Ave": "/attached_assets/149 Crystal Ave _1754934705754.JPG",
  "157 Crystal Ave": "/attached_assets/157 crystal ave_1754938607514.jpeg",
  "default": "https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&h=500"
};

export const getPropertyImage = (propertyName: string): string => {
  return propertyImages[propertyName as keyof typeof propertyImages] || propertyImages.default;
};
