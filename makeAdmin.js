const mongoose = require('mongoose');
const User = require('./models/User');

// Connect to MongoDB
mongoose.connect('mongodb://127.0.0.1:27017/movie-app', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

async function makeAdmin(email) {
  try {
    const user = await User.findOneAndUpdate(
      { email: email.toLowerCase() },
      { role: 'admin' },
      { new: true }
    );

    if (user) {
      console.log('Successfully updated user to admin:', user.email);
    } else {
      console.log('User not found with email:', email);
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    mongoose.connection.close();
  }
}

// Get email from command line argument
const email = process.argv[2];
if (!email) {
  console.log('Please provide an email address');
  process.exit(1);
}

makeAdmin(email); 