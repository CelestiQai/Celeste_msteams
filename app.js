require('dotenv').config();
const process = require('node:process');
const express = require('express');
const axios = require('axios').default;
const botbuilder = require('botbuilder');
const { MessageFactory, CardFactory } = require('botbuilder');
const localtunnel = require('localtunnel');
let tunnel = null;

const DMconfig = {
  tts: false,
  stripSSML: false,
};

// Create HTTP server.
const app = express();
const server = app.listen(process.env.PORT || 3978, async function () {
  const { port } = server.address();
  console.log(`\nServer listening on port ${port} in ${app.settings.env} mode`);

  // Setup the tunnel for testing
  if (app.settings.env === 'development') {
    tunnel = await localtunnel({
      port: port,
      subdomain: process.env.TUNNEL_SUBDOMAIN,
    });
    console.log(`\nEndpoint (LocalTunnel): ${tunnel.url}/api/messages`);

    tunnel.on('close', () => {
      console.log('\n\nClosing tunnel');
    });
  } else {
    console.log(`\nEndpoint (Azure): ${process.env.AZURE_APP_URL}/api/messages`);
  }

  console.log('\n');

  // Output a periodic message for interactive terminals
  if (process.stdout.isTTY) {
    let i = 0; // dots counter
    setInterval(function () {
      process.stdout.clearLine(); // clear current text
      process.stdout.cursorTo(0); // move cursor to the beginning of the line
      i = (i + 1) % 4;
      const dots = new Array(i + 1).join('.');
      process.stdout.write('Listening' + dots); // write text
    }, 300);
  } else {
    console.log('Listening...');
  }
});

// Default GET route for testing the server
app.get('/', (req, res) => {
  res.send('Bot is running!');
});

// Create bot adapter, which defines how the bot sends and receives messages.
const adapter = new botbuilder.BotFrameworkAdapter({
  appId: process.env.MicrosoftAppId,
  appPassword: process.env.MicrosoftAppPassword,
});

// Catch-all for errors.
const onTurnErrorHandler = async (context, error) => {
  console.error(`\n [onTurnError] unhandled error: ${error}`);
  await context.sendTraceActivity(
    'OnTurnError Trace',
    `${error}`,
    'https://www.botframework.com/schemas/error',
    'TurnError'
  );
  await context.sendActivity('The bot encountered an error or bug.');
  await context.sendActivity('Please check the bot source code for errors.');
};
adapter.onTurnError = onTurnErrorHandler;

// Listen for incoming requests at /api/messages.
app.post('/api/messages', async (req, res) => {
  adapter.processActivity(req, res, async (turnContext) => {
    if (turnContext.activity.type === 'message') {
      const user_id = turnContext.activity.from.id;
      const utterance = turnContext.activity.text;
      try {
        const response = await interact(user_id, { type: 'text', payload: utterance }, turnContext);
        if (response.length > 0) {
          await sendMessage(response, turnContext);
        }
      } catch (error) {
        console.error(`\n[Error in processing message]: ${error.message}`);
        await turnContext.sendActivity('There was an issue processing your message.');
      }
    }
  });
});

// Function to interact with Voiceflow API.
async function interact(user_id, request, turnContext) {
  try {
    // Update {user_id} variable with DM API
    await axios.patch(
      `${process.env.VOICEFLOW_RUNTIME_ENDPOINT}/state/user/${encodeURI(user_id)}/variables`,
      { user_id },
      {
        headers: {
          Authorization: process.env.VOICEFLOW_API_KEY,
          'Content-Type': 'application/json',
        },
      }
    );

    // Interact with DM API
    const response = await axios.post(
      `${process.env.VOICEFLOW_RUNTIME_ENDPOINT}/state/user/${encodeURI(user_id)}/interact`,
      {
        action: request,
        config: DMconfig,
      },
      {
        headers: {
          Authorization: process.env.VOICEFLOW_API_KEY,
          'Content-Type': 'application/json',
          versionID: process.env.VOICEFLOW_VERSION,
        },
      }
    );

    return parseResponses(response.data);
  } catch (error) {
    console.error(`\n[Error in interact function]: ${error.message}`);
    await turnContext.sendActivity('Failed to communicate with Voiceflow API.');
    return [];
  }
}

// Function to parse responses from Voiceflow API.
function parseResponses(data) {
  const responses = [];
  data.forEach((item) => {
    if (item.type === 'text') {
      const text = item.payload.slate.content
        .map((block) => block.children.map((child) => child.text || '').join(''))
        .join('\n');
      responses.push({ type: 'text', value: text });
    } else if (item.type === 'visual') {
      responses.push({ type: 'image', value: item.payload.image });
    } else if (item.type === 'choice') {
      const buttons = item.payload.buttons.map((button) => ({ label: button.request.payload.label }));
      responses.push({ type: 'buttons', buttons });
    }
  });
  return responses;
}

// Function to send messages to the user.
async function sendMessage(messages, turnContext) {
  for (const message of messages) {
    if (message.type === 'image') {
      const card = CardFactory.heroCard(null, [message.value]);
      await turnContext.sendActivity(MessageFactory.attachment(card));
    } else if (message.type === 'buttons') {
      const actions = message.buttons.map((button) => button.label);
      const card = CardFactory.heroCard(null, null, actions);
      await turnContext.sendActivity(MessageFactory.attachment(card));
    } else if (message.type === 'text') {
      await turnContext.sendActivity(message.value);
    }
  }
}

// Handle process termination.
process.on('SIGINT', () => process.exit());
process.on('exit', () => {
  if (process.env.NODE_ENV === 'development' && tunnel) {
    tunnel.close();
  }
  console.log('Bye!\n\n');
});
