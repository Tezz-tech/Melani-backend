/**
 * Seed script — populates DB with sample products for testing
 * Run: node src/utils/seed.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Product  = require('../models/Product');
const logger   = require('./logger');

const SAMPLE_PRODUCTS = [
  {
    name:'Gentle Foaming Cleanser', brand:'CeraVe', category:'cleanser',
    priceNGN:6800, suitableFor:['oily','combination','all'],
    keyIngredients:['ceramides','niacinamide','hyaluronic acid'],
    avoidIngredients:[], conditions:['acne','dryness'],
    availability:'Jumia, Konga, leading pharmacies', rating:4.7,
    fitzpatrickMin:1, fitzpatrickMax:6, isActive:true, isFeatured:true, country:'NG',
  },
  {
    name:'10% Niacinamide Serum', brand:'The Ordinary', category:'serum',
    priceNGN:3200, suitableFor:['oily','combination','normal','all'],
    keyIngredients:['niacinamide','zinc'], conditions:['PIH','acne','uneven tone'],
    availability:'Jumia, Beauty stores', rating:4.8,
    fitzpatrickMin:1, fitzpatrickMax:6, isActive:true, isFeatured:true, country:'NG',
  },
  {
    name:'Alpha Arbutin 2% + HA', brand:'The Ordinary', category:'serum',
    priceNGN:4100, suitableFor:['all'],
    keyIngredients:['alpha arbutin','hyaluronic acid'], conditions:['hyperpigmentation','PIH','dark spots'],
    availability:'Jumia, Konga', rating:4.6,
    fitzpatrickMin:3, fitzpatrickMax:6, isActive:true, isFeatured:true, country:'NG',
  },
  {
    name:'SPF 50 Sunscreen (Matte)', brand:'Neutrogena', category:'spf',
    priceNGN:5500, suitableFor:['oily','combination','all'],
    keyIngredients:['zinc oxide','titanium dioxide'], conditions:['PIH','hyperpigmentation'],
    availability:'Shoprite, Jumia, pharmacies', rating:4.5,
    fitzpatrickMin:1, fitzpatrickMax:6, isActive:true, isFeatured:false, country:'NG',
  },
  {
    name:'Moisturising Lotion with SPF 15', brand:'Olay', category:'moisturiser',
    priceNGN:3800, suitableFor:['dry','normal','combination'],
    keyIngredients:['vitamin B3','glycerin'], conditions:['dryness','dullness'],
    availability:'Shoprite, supermarkets', rating:4.3,
    fitzpatrickMin:1, fitzpatrickMax:6, isActive:true, isFeatured:false, country:'NG',
  },
  {
    name:'African Black Soap', brand:'Shea Moisture', category:'cleanser',
    priceNGN:4200, suitableFor:['oily','acne-prone','all'],
    keyIngredients:['shea butter','oat extract','vitamin E'], conditions:['acne','PIH'],
    availability:'Beauty stores, Jumia', rating:4.4,
    fitzpatrickMin:3, fitzpatrickMax:6, isActive:true, isFeatured:true, country:'NG', tags:['african'],
  },
];

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  await Product.deleteMany({});
  await Product.insertMany(SAMPLE_PRODUCTS);
  logger.info(`Seeded ${SAMPLE_PRODUCTS.length} products`);
  await mongoose.disconnect();
  process.exit(0);
})();