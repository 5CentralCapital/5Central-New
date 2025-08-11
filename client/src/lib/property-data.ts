export const propertyImages = {
  "3408 E Dr MLK BLVD": "/3408-mlk-blvd.png",
  "157 Crystal Ave": "/157-crystal-ave.jpeg",
  "1 Harmony St": "/properties/1-harmony-st.jpg",
  "41 Stuart Ave": "/properties/41-stuart-ave.jpg",
  "52 Summit Ave": "/properties/52-summit-ave.jpg",
  "29 Brainard St": "/properties/29-brainard-st.jpg",
  "25 Huntington Pl": "/properties/25-huntington-pl.jpg",
  "175 Crystal Ave": "/175-crystal-ave.jpg",
  "35 Linden St": "/properties/35-linden-st.jpg",
  "145 Crystal Ave": "/properties/145-crystal-ave.jpg",
  "149 Crystal Ave": "/properties/149-crystal-ave.jpg",
  "default": "https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?ixlib=rb-4.0.3&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=800&h=500"
};

export const getPropertyImage = (propertyName: string): string => {
  return propertyImages[propertyName as keyof typeof propertyImages] || propertyImages.default;
};
