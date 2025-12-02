# IDRP OFT Architecture & Integration

## Overview

The IDRP project utilizes the **LayerZero OFT (Omnichain Fungible Token)** standard to enable global supply management while maintaining a secure, centralized control authority on a Canonical Chain.

## Architecture Strategy: Canonical-Only Authority

We adopt an **Adapter + OFT** pattern. This allows us to keep our existing, audited IDRP contracts on the Canonical Chain without modification, while extending reach to other chains.

### Components

1.  **Canonical Chain (Base Sepolia / Polygon)**

    - **IDRP Token:** The source of truth for the token.
    - **IDRP Controller:** Handles Mint/Burn/Freeze/Pause logic.
    - **OFT Adapter:** Wraps the IDRP Token. It locks tokens when users bridge _out_ and unlocks them when users bridge _in_.

2.  **Remote Chains (Arbitrum, Tron, etc.)**
    - **OFT Contract:** A token contract that implements LayerZero messaging. It mints tokens when receiving a message from the Adapter and burns them when sending a message to the Adapter.

### Diagrams

- [High Level Architecture](./idrp_architecture.mmd) - Visualizes the flow of tokens and control.
- [Wiring Diagram](./oft_wiring.mmd) - Visualizes the `setPeer` connections required for deployment.
- [User Flow Diagrams](./user_flow.mmd) - Illustrates user interactions for bridging and administrative actions.

### Operational Flows

#### 1. Bridging Out (Canonical -> Remote)

1.  User calls `send()` on **OFT Adapter**.
2.  Adapter transfers IDRP from User to Adapter (Lock).
3.  LayerZero sends message to Remote Chain.
4.  **OFT Contract** on Remote Chain receives message.
5.  OFT Contract mints equivalent amount to User.

#### 2. Bridging In (Remote -> Canonical)

1.  User calls `send()` on **OFT Contract**.
2.  OFT Contract burns tokens from User.
3.  LayerZero sends message to Canonical Chain.
4.  **OFT Adapter** receives message.
5.  Adapter transfers IDRP from Adapter to User (Unlock).

#### 3. Administrative Operations (Freeze/Pause)

- **Current Status:** Operations are performed on the Canonical Chain via the Controller.
- **Future Upgrade:** To enforce freeze/pause on remote chains, we can utilize the Upgradeable nature of our OFT contracts to listen for state synchronization messages from the Canonical Controller, or rely on the bridge pausing if the Canonical chain is paused.
