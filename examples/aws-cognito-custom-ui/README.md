# Aws cognito custom ui with openlogin

## If you want to use your own verifier then create .env file with following variables:-

```
// your aws cognito user pool id
REACT_APP_USERPOOL_ID=  

// your aws cognito app client id
REACT_APP_CLIENT_ID=

// your custom jwt verifier
REACT_APP_VERIFIER=
```

- Note: By default torus demo verifier and aws cognito config is being used.
## Available Scripts

In the project directory, you can run:

### `yarn start`

Runs the app in the development mode.\
Open [http://localhost:3000](http://localhost:3000) to view it in the browser.

The page will reload if you make edits.\
You will also see any lint errors in the console.

### `yarn test`

Launches the test runner in the interactive watch mode.\
See the section about [running tests](https://facebook.github.io/create-react-app/docs/running-tests) for more information.

### `yarn build`

Builds the app for production to the `build` folder.\
It correctly bundles React in production mode and optimizes the build for the best performance.

The build is minified and the filenames include the hashes.\
Your app is ready to be deployed!

See the section about [deployment](https://facebook.github.io/create-react-app/docs/deployment) for more information.