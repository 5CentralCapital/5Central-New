# 5Central Capital

## Overview

5Central Capital is a Tampa-based real estate investment firm specializing in multifamily property acquisitions and value creation. The application is a full-stack web platform showcasing the company's portfolio, performance metrics, and investment strategy. Built as a modern web application with a React frontend and Express backend, it presents professional property data, financial metrics, and company information to potential investors and stakeholders.

The platform displays current and sold properties with detailed financial performance data including IRR (Internal Rate of Return), equity multiples, cash flow, and acquisition details. It serves as both a marketing tool and a portfolio management dashboard for the investment firm.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React with TypeScript using Vite as the build tool
- **UI Library**: Shadcn/ui components built on Radix UI primitives for consistent, accessible design
- **Styling**: Tailwind CSS with custom design tokens and CSS variables for theming
- **Routing**: Wouter for lightweight client-side routing
- **State Management**: TanStack Query (React Query) for server state management and caching
- **Typography**: Custom font stack using Inter (sans-serif) and Playfair Display (serif) from Google Fonts

### Backend Architecture
- **Runtime**: Node.js with Express.js framework
- **Language**: TypeScript with ES modules
- **API Design**: RESTful API endpoints for property data retrieval
- **Storage**: In-memory storage implementation (MemStorage class) with interface for future database integration
- **Development**: Hot module replacement with Vite integration for seamless development experience

### Database Schema Design
- **ORM**: Drizzle ORM configured for PostgreSQL
- **Schema**: Defined in TypeScript with strong typing
- **Tables**: 
  - Users table with authentication fields
  - Properties table with comprehensive real estate metrics (acquisition price, current value, IRR, equity multiples, cash flow, etc.)
- **Validation**: Zod schemas for runtime type checking and validation

### Component Architecture
- **Design System**: Modular UI components with consistent styling patterns
- **Layout**: Responsive design with mobile-first approach
- **Navigation**: Sticky navigation with scroll-based styling changes
- **Card-based UI**: Property cards with hover effects and visual hierarchy
- **Performance Metrics**: Dashboard-style metrics display with formatted financial data

### Development Workflow
- **Build Process**: Vite for frontend bundling, esbuild for server compilation
- **Development Server**: Integrated Vite dev server with Express API proxy
- **Asset Management**: Vite handles static asset optimization and hot reloading
- **Type Safety**: Full TypeScript coverage across frontend, backend, and shared schemas

### Content Management
- **Property Images**: Integration with Unsplash for high-quality property photography
- **Data Initialization**: Hardcoded property data with real financial metrics from Connecticut and Florida markets
- **Performance Calculations**: Automated calculation of portfolio-wide metrics from individual property data

## External Dependencies

### Development Dependencies
- **Vite**: Frontend build tool and development server
- **TypeScript**: Type system and compiler
- **ESBuild**: Fast JavaScript/TypeScript bundler for production builds
- **Drizzle Kit**: Database schema management and migrations

### UI and Styling
- **Radix UI**: Primitive components for accessibility and functionality
- **Tailwind CSS**: Utility-first CSS framework
- **Lucide React**: Icon library with consistent design
- **Class Variance Authority**: Component variant styling utility

### Data and State Management
- **TanStack Query**: Server state management and caching
- **React Hook Form**: Form state management and validation
- **Zod**: Runtime type validation and schema definition

### Database and ORM
- **Drizzle ORM**: Type-safe SQL query builder
- **PostgreSQL**: Planned database (Neon serverless PostgreSQL configured)
- **Connect-pg-simple**: PostgreSQL session store for future authentication

### Image and Media
- **Unsplash**: External image service for property photography
- **Google Fonts**: Web fonts (Inter and Playfair Display)

### Development Tools
- **Replit**: Development environment integration
- **PostCSS**: CSS processing with Autoprefixer
- **Date-fns**: Date manipulation and formatting utilities

The application is designed for easy deployment and scaling, with clear separation between frontend and backend concerns, and a database-ready architecture that can be easily connected to PostgreSQL when needed.